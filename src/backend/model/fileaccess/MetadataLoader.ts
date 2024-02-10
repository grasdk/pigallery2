import * as fs from 'fs';
import { imageSize } from 'image-size';
import { Config } from '../../../common/config/private/Config';
import { SideCar } from '../../../common/entities/MediaDTO';
import { FaceRegion, PhotoMetadata } from '../../../common/entities/PhotoDTO';
import { VideoMetadata } from '../../../common/entities/VideoDTO';
import { Logger } from '../../Logger';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as exifr from 'exifr';
import { FfprobeData } from 'fluent-ffmpeg';
import { FileHandle } from 'fs/promises';
import * as util from 'node:util';
import * as path from 'path';
import { IptcParser } from 'ts-node-iptc';
import { Utils } from '../../../common/Utils';
import { FFmpegFactory } from '../FFmpegFactory';
import { ExtensionDecorator } from '../extension/ExtensionDecorator';

const LOG_TAG = '[MetadataLoader]';
const ffmpeg = FFmpegFactory.get();

export class MetadataLoader {

  @ExtensionDecorator(e => e.gallery.MetadataLoader.loadVideoMetadata)
  public static async loadVideoMetadata(fullPath: string): Promise<VideoMetadata> {
    const metadata: VideoMetadata = {
      size: {
        width: 1,
        height: 1,
      },
      bitRate: 0,
      duration: 0,
      creationDate: 0,
      fileSize: 0,
      fps: 0,
    };

    try {
      const stat = fs.statSync(fullPath);
      metadata.fileSize = stat.size;
      metadata.creationDate = stat.mtime.getTime();
    } catch (err) {
      console.log(err);
      // ignoring errors
    }
    try {


      const data: FfprobeData = await util.promisify<FfprobeData>(
        // wrap to arrow function otherwise 'this' is lost for ffprobe
        (cb) => ffmpeg(fullPath).ffprobe(cb)
      )();

      try {
        for (const stream of data.streams) {
          if (stream.width) {
            metadata.size.width = stream.width;
            metadata.size.height = stream.height;

            if (
              Utils.isInt32(parseInt('' + stream.rotation, 10)) &&
              (Math.abs(parseInt('' + stream.rotation, 10)) / 90) % 2 === 1
            ) {
              // noinspection JSSuspiciousNameCombination
              metadata.size.width = stream.height;
              // noinspection JSSuspiciousNameCombination
              metadata.size.height = stream.width;
            }

            if (
              Utils.isInt32(Math.floor(parseFloat(stream.duration) * 1000))
            ) {
              metadata.duration = Math.floor(
                parseFloat(stream.duration) * 1000
              );
            }

            if (Utils.isInt32(parseInt(stream.bit_rate, 10))) {
              metadata.bitRate = parseInt(stream.bit_rate, 10) || null;
            }
            if (Utils.isInt32(parseInt(stream.avg_frame_rate, 10))) {
              metadata.fps = parseInt(stream.avg_frame_rate, 10) || null;
            }
            metadata.creationDate =
              Date.parse(stream.tags.creation_time) ||
              metadata.creationDate;
            break;
          }
        }

        // For some filetypes (for instance Matroska), bitrate and duration are stored in
        // the format section, not in the stream section.

        // Only use duration from container header if necessary (stream duration is usually more accurate)
        if (
          metadata.duration === 0 &&
          data.format.duration !== undefined &&
          Utils.isInt32(Math.floor(data.format.duration * 1000))
        ) {
          metadata.duration = Math.floor(data.format.duration * 1000);
        }

        // Prefer bitrate from container header (includes video and audio)
        if (
          data.format.bit_rate !== undefined &&
          Utils.isInt32(data.format.bit_rate)
        ) {
          metadata.bitRate = data.format.bit_rate;
        }

        if (
          data.format.tags !== undefined &&
          typeof data.format.tags.creation_time === 'string'
        ) {
          metadata.creationDate =
            Date.parse(data.format.tags.creation_time) ||
            metadata.creationDate;
        }

        // eslint-disable-next-line no-empty
      } catch (err) {
        Logger.silly(LOG_TAG, 'Error loading metadata for : ' + fullPath);
        Logger.silly(err);
      }
      metadata.creationDate = metadata.creationDate || 0;

      try {
        // search for sidecar and merge metadata
        const fullPathWithoutExt = path.parse(fullPath).name;
        const sidecarPaths = [
          fullPath + '.xmp',
          fullPath + '.XMP',
          fullPathWithoutExt + '.xmp',
          fullPathWithoutExt + '.XMP',
        ];

        for (const sidecarPath of sidecarPaths) {
          if (fs.existsSync(sidecarPath)) {
            const sidecarData = await exifr.sidecar(sidecarPath);
            if (sidecarData !== undefined) {
              if ((sidecarData as SideCar).dc.subject !== undefined) {
                if (metadata.keywords === undefined) {
                  metadata.keywords = [];
                }
                for (const kw of (sidecarData as SideCar).dc.subject) {
                  if (metadata.keywords.indexOf(kw) === -1) {
                    metadata.keywords.push(kw);
                  }
                }
              }
              if ((sidecarData as SideCar).xmp.Rating !== undefined) {
                metadata.rating = (sidecarData as SideCar).xmp.Rating;
              }
            }
          }
        }
      } catch (err) {
        Logger.silly(LOG_TAG, 'Error loading sidecar metadata for : ' + fullPath);
        Logger.silly(err);
      }

    } catch (err) {
      Logger.silly(LOG_TAG, 'Error loading metadata for : ' + fullPath);
      Logger.silly(err);
    }
    return metadata;
  }

  private static readonly EMPTY_METADATA: PhotoMetadata = {
    size: { width: 0, height: 0 },
    creationDate: 0,
    fileSize: 0,
  };

  @ExtensionDecorator(e => e.gallery.MetadataLoader.loadPhotoMetadata)
  public static async loadPhotoMetadata(fullPath: string): Promise<PhotoMetadata> {
    let fileHandle: FileHandle;
    const metadata: PhotoMetadata = {
      size: { width: 0, height: 0 },
      creationDate: 0,
      fileSize: 0,
    };
    const exifrOptions = {
      tiff: true,
      xmp: true,
      icc: false,
      jfif: false, //not needed and not supported for png
      ihdr: true,
      iptc: false, //exifr reads UTF8-encoded data wrongly, using IptcParser instead
      exif: true,
      gps: true,
      reviveValues: false, //don't convert timestamps
      translateValues: false, //don't translate orientation from numbers to strings etc.
      mergeOutput: false //don't merge output, because things like Microsoft Rating (percent) and xmp.rating will be merged
    };

    //function to convert timestamp into milliseconds taking offset into account
    const timestampToMS = (timestamp: string, offset: string) => {
      "replace first two : with - in timestamp string and add offset if exists (else +00:00 - UTC), parse this into MS"
      return Date.parse(timestamp.replace(':', '-').replace(':', '-') + (offset ? offset : '+00:00'));
    }

    const getTimeOffsetByGPSStamp = (timestamp: string, gps: any) => {
      if (gps &&
          gps.GPSDateStamp &&
          gps.GPSTimeStamp) {
        //GPS timestamp is always UTC (+00:00)
        let gpsTimestamp = gps.GPSDateStamp.replaceAll(':', '-') + gps.GPSTimeStamp.join(':')+'+00:00';
        //offset in minutes is the difference between given timestamp and gps timestamp
        let offsetMinutes = ((Date.parse(timestamp) - Date.parse(gpsTimestamp)) / 1000 / 60);
        if (-720 <= offsetMinutes && offsetMinutes <= 840) { 
          //valid offset is within -12 and +14 hrs (https://en.wikipedia.org/wiki/List_of_UTC_offsets)
          return (offsetMinutes<0?"-":"+") + //leading +/-
                  ("0"+Math.trunc(Math.abs(offsetMinutes) / 60)).slice(-2) + ":" +  //zeropadded hours and :
                  ("0"+           Math.abs(offsetMinutes) % 60).slice(-2);          //zeropadded minutes
        } else {
          return undefined;
        }
      } else {
        return undefined;
      }
    }

    try {
      const data = Buffer.allocUnsafe(Config.Media.photoMetadataSize);
      fileHandle = await fs.promises.open(fullPath, 'r');
      try {
        await fileHandle.read(data, 0, Config.Media.photoMetadataSize, 0);
      } catch (err) {
        Logger.error(LOG_TAG, 'Error during reading photo: ' + fullPath);
        console.error(err);
        return MetadataLoader.EMPTY_METADATA;
      } finally {
        await fileHandle.close();
      }
      try {
        try {
          const stat = fs.statSync(fullPath);
          metadata.fileSize = stat.size;
          metadata.creationDate = stat.mtime.getTime();
        } catch (err) {
          // ignoring errors
        }

        try { //Parse iptc data using the IptcParser, which works correctly for both UTF-8 and ASCII
          const iptcData = IptcParser.parse(data);
          if (iptcData.country_or_primary_location_name) {
            metadata.positionData = metadata.positionData || {};
            metadata.positionData.country =
              iptcData.country_or_primary_location_name
                .replace(/\0/g, '')
                .trim();
          }
          if (iptcData.province_or_state) {
            metadata.positionData = metadata.positionData || {};
            metadata.positionData.state = iptcData.province_or_state
              .replace(/\0/g, '')
              .trim();
          }
          if (iptcData.city) {
            metadata.positionData = metadata.positionData || {};
            metadata.positionData.city = iptcData.city
              .replace(/\0/g, '')
              .trim();
          }
          if (iptcData.object_name) {
            metadata.title = iptcData.object_name.replace(/\0/g, '').trim();
          }
          if (iptcData.caption) {
            metadata.caption = iptcData.caption.replace(/\0/g, '').trim();
          }
          if (Array.isArray(iptcData.keywords)) {
            metadata.keywords = iptcData.keywords;
          }

          if (iptcData.date_time) {
            metadata.creationDate = iptcData.date_time.getTime();
          }
        } catch (err) {
          // Logger.debug(LOG_TAG, 'Error parsing iptc data', fullPath, err);
        }

        try {
          let orientation = 1; //Orientation 1 is normal
          const exif = await exifr.parse(data, exifrOptions);
          //exif is structured in sections, we read the data by section

          //dc-section (subject is the only tag we want from dc)
          if (exif.dc &&
            exif.dc.subject &&
            exif.dc.subject.length > 0) {
            const subj = Array.isArray(exif.dc.subject) ? exif.dc.subject : [exif.dc.subject];
            if (metadata.keywords === undefined) {
              metadata.keywords = [];
            }
            for (const kw of subj) {
              if (metadata.keywords.indexOf(kw) === -1) {
                metadata.keywords.push(kw);
              }
            }
          }

          //ifd0 section
          if (exif.ifd0) {
            if (exif.ifd0.ImageWidth && metadata.size.width <= 0) {
              metadata.size.width = exif.ifd0.ImageWidth;
            }
            if (exif.ifd0.ImageHeight && metadata.size.height <= 0) {
              metadata.size.height = exif.ifd0.ImageHeight;
            }
            if (exif.ifd0.Orientation) {
              orientation = parseInt(
                exif.ifd0.Orientation as any,
                10
              ) as number;
            }
            if (exif.ifd0.Make && exif.ifd0.Make !== '') {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.make = '' + exif.ifd0.Make;
            }
            if (exif.ifd0.Model && exif.ifd0.Model !== '') {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.model = '' + exif.ifd0.Model;
            }
            //if (exif.ifd0.ModifyDate) {} //Deferred to the exif-section where the other timestamps are
          }

          //exif section
          if (exif.exif) {
            if (exif.exif.DateTimeOriginal) {
              //DateTimeOriginal is when the camera shutter closed
              if (exif.exif.OffsetTimeOriginal) { //OffsetTimeOriginal is the corresponding offset
                metadata.creationDate = timestampToMS(exif.exif.DateTimeOriginal, exif.exif.OffsetTimeOriginal);
                metadata.creationDateOffset = exif.exif.OffsetTimeOriginal;
              } else {
                let alt_offset = exif.exif.OffsetTimeDigitized || exif.exif.OffsetTime || getTimeOffsetByGPSStamp(exif.exif.DateTimeOriginal, exif.gps);
                metadata.creationDate = timestampToMS(exif.exif.DateTimeOriginal, alt_offset);
                metadata.creationDateOffset = alt_offset;
              }
            } else if (exif.exif.CreateDate) { //using else if here, because DateTimeOriginal has preceedence
              //Create is when the camera wrote the file (typically within the same ms as shutter close)
              if (exif.exif.OffsetTimeDigitized) { //OffsetTimeDigitized is the corresponding offset
                metadata.creationDate = timestampToMS(exif.exif.CreateDate, exif.exif.OffsetTimeDigitized);
                metadata.creationDateOffset = exif.exif.OffsetTimeDigitized;
              } else {
                let alt_offset = exif.exif.OffsetTimeOriginal || exif.exif.OffsetTime || getTimeOffsetByGPSStamp(exif.exif.DateTimeOriginal, exif.gps);
                metadata.creationDate = timestampToMS(exif.exif.DateTimeOriginal, alt_offset);
                metadata.creationDateOffset = alt_offset;
              }
            } else if (exif.ifd0?.ModifyDate) { //using else if here, because DateTimeOriginal and Create data have preceedence
              if (exif.exif.OffsetTime) {
                //exif.Offsettime is the offset corresponding to ifd0.ModifyDate
                metadata.creationDate = timestampToMS(exif.ifd0.ModifyDate, exif.exif?.OffsetTime);
                metadata.creationDateOffset = exif.exif?.OffsetTime
              } else {
                let alt_offset = exif.exif.DateTimeOriginal || exif.exif.OffsetTimeDigitized || getTimeOffsetByGPSStamp(exif.ifd0.ModifyDate, exif.gps);
                metadata.creationDate = timestampToMS(exif.ifd0.ModifyDate, alt_offset);
                metadata.creationDateOffset = alt_offset;
              }
            }
            if (exif.exif.LensModel && exif.exif.LensModel !== '') {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.lens = '' + exif.exif.LensModel;
            }
            if (Utils.isUInt32(exif.exif.ISO)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.ISO = parseInt('' + exif.exif.ISO, 10);
            }
            if (Utils.isFloat32(exif.exif.FocalLength)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.focalLength = parseFloat(
                '' + exif.exif.FocalLength
              );
            }
            if (Utils.isFloat32(exif.exif.ExposureTime)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.exposure = parseFloat(
                parseFloat('' + exif.exif.ExposureTime).toFixed(6)
              );
            }
            if (Utils.isFloat32(exif.exif.FNumber)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.fStop = parseFloat(
                parseFloat('' + exif.exif.FNumber).toFixed(2)
              );
            }
            if (exif.exif.ExifImageWidth && metadata.size.width <= 0) {
              metadata.size.width = exif.exif.ExifImageWidth;
            }
            if (exif.exif.ExifImageHeight && metadata.size.height <= 0) {
              metadata.size.height = exif.exif.ExifImageHeight;
            }
          }

          //gps section
          if (exif.gps) {
            metadata.positionData = metadata.positionData || {};
            metadata.positionData.GPSData = metadata.positionData.GPSData || {};

            if (Utils.isFloat32(exif.gps.longitude)) {
              metadata.positionData.GPSData.longitude = parseFloat(
                exif.gps.longitude.toFixed(6)
              );
            }
            if (Utils.isFloat32(exif.gps.latitude)) {
              metadata.positionData.GPSData.latitude = parseFloat(
                exif.gps.latitude.toFixed(6)
              );
            }

            if (metadata.positionData) {
              if (!metadata.positionData.GPSData ||
                  Object.keys(metadata.positionData.GPSData).length === 0) {
                metadata.positionData.GPSData = undefined;
                metadata.positionData = undefined;
              }
            }
          }

          
          //Try to fix image size if possible START
          ///////////////////////////////////////
          if (metadata.size.width <= 0 || metadata.size.height <= 0) {
            //if none of the tags gave us the image size, we will try to use the image-size library instead
            try {
              //read the actual image size, don't rely on tags for this
              const info = imageSize(fullPath);
              metadata.size = { width: info.width, height: info.height };
            } catch (e) {
              metadata.size = { width: Math.max(metadata.size.width, 1), height: Math.max(metadata.size.height, 1) };
            }
          }
    
          //Before moving on to the XMP section (particularly the regions (mwg-rs))
          //we need to switch width and height for images that are rotated sideways
          if (4 < orientation) { //Orientation is sideways (rotated 90% or 270%)
            // noinspection JSSuspiciousNameCombination
            const height = metadata.size.width;
            // noinspection JSSuspiciousNameCombination
            metadata.size.width = metadata.size.height;
            metadata.size.height = height;
          }
          ///////////////////////////////////////
          //Try to fix image size if possible END


          //xmp section
          if (exif.xmp && exif.xmp.Rating) {
            metadata.rating = exif.xmp.Rating;
            if (metadata.rating < 0) {
              metadata.rating = 0;
            }
          }
          //xmp."mwg-rs" section
          if (Config.Faces.enabled &&
            exif["mwg-rs"] &&
            exif["mwg-rs"].Regions) {
            const faces: FaceRegion[] = [];
            const regionListVal = Array.isArray(exif["mwg-rs"].Regions.RegionList) ? exif["mwg-rs"].Regions.RegionList : [exif["mwg-rs"].Regions.RegionList];
            if (regionListVal) {
              for (const regionRoot of regionListVal) {
                let type;
                let name;
                let box;
                const createFaceBox = (
                  w: string,
                  h: string,
                  x: string,
                  y: string
                ) => {
                  if (4 < orientation) { //roation is sidewards (90 or 270 degrees)
                    [x, y] = [y, x];
                    [w, h] = [h, w];
                  }
                  let swapX = 0;
                  let swapY = 0;
                  switch (orientation) {
                    case 2: //TOP RIGHT (Mirror horizontal):
                    case 6: //RIGHT TOP (Rotate 90 CW)
                      swapX = 1;
                      break;
                    case 3: // BOTTOM RIGHT (Rotate 180)
                    case 7: // RIGHT BOTTOM (Mirror horizontal and rotate 90 CW)
                      swapX = 1;
                      swapY = 1;
                      break;
                    case 4: //BOTTOM_LEFT (Mirror vertical)
                    case 8: //LEFT_BOTTOM (Rotate 270 CW)
                      swapY = 1;
                      break;
                  }
                  // converting ratio to px
                  return {
                    width: Math.round(parseFloat(w) * metadata.size.width),
                    height: Math.round(parseFloat(h) * metadata.size.height),
                    left: Math.round(Math.abs(parseFloat(x) - swapX) * metadata.size.width),
                    top: Math.round(Math.abs(parseFloat(y) - swapY) * metadata.size.height),
                  };
                };
                /* Adobe Lightroom based face region structure */
                if (
                  regionRoot &&
                  regionRoot['rdf:Description'] &&
                  regionRoot['rdf:Description'] &&
                  regionRoot['rdf:Description']['mwg-rs:Area']
                ) {
                  const region = regionRoot['rdf:Description'];
                  const regionBox = region['mwg-rs:Area'].attributes;

                  name = region['mwg-rs:Name'];
                  type = region['mwg-rs:Type'];
                  box = createFaceBox(
                    regionBox['stArea:w'],
                    regionBox['stArea:h'],
                    regionBox['stArea:x'],
                    regionBox['stArea:y']
                  );
                  /* Load exiftool edited face region structure, see github issue #191 */
                } else if (
                  regionRoot &&
                  regionRoot.Name &&
                  regionRoot.Type &&
                  regionRoot.Area
                ) {
                  const regionBox = regionRoot.Area;
                  name = regionRoot.Name;
                  type = regionRoot.Type;
                  box = createFaceBox(
                    regionBox.w,
                    regionBox.h,
                    regionBox.x,
                    regionBox.y
                  );
                }

                if (type !== 'Face' || !name) {
                  continue;
                }

                // convert center base box to corner based box
                box.left = Math.round(Math.max(0, box.left - box.width / 2));
                box.top = Math.round(Math.max(0, box.top - box.height / 2));


                faces.push({ name, box });
              }
            }
            if (faces.length > 0) {
              metadata.faces = faces; // save faces
              if (Config.Faces.keywordsToPersons) {
                // remove faces from keywords
                metadata.faces.forEach((f) => {
                  const index = metadata.keywords.indexOf(f.name);
                  if (index !== -1) {
                    metadata.keywords.splice(index, 1);
                  }
                });
              }
            }
          }
        } catch (err) {
          // ignoring errors
        }

        if (!metadata.creationDate) {
          // creationDate can be negative, when it was created before epoch (1970)
          metadata.creationDate = 0;
        }

        try {
          // search for sidecar and merge metadata
          const fullPathWithoutExt = path.parse(fullPath).name;
          const sidecarPaths = [
            fullPath + '.xmp',
            fullPath + '.XMP',
            fullPathWithoutExt + '.xmp',
            fullPathWithoutExt + '.XMP',
          ];

          for (const sidecarPath of sidecarPaths) {
            if (fs.existsSync(sidecarPath)) {
              const sidecarData = await exifr.sidecar(sidecarPath);

              if (sidecarData !== undefined) {
                if ((sidecarData as SideCar).dc.subject !== undefined) {
                  if (metadata.keywords === undefined) {
                    metadata.keywords = [];
                  }
                  for (const kw of (sidecarData as SideCar).dc.subject) {
                    if (metadata.keywords.indexOf(kw) === -1) {
                      metadata.keywords.push(kw);
                    }
                  }
                }
                if ((sidecarData as SideCar).xmp.Rating !== undefined) {
                  metadata.rating = (sidecarData as SideCar).xmp.Rating;
                }
              }
            }
          }
        } catch (err) {
          Logger.silly(LOG_TAG, 'Error loading sidecar metadata for : ' + fullPath);
          Logger.silly(err);
        }

      } catch (err) {
        Logger.error(LOG_TAG, 'Error during reading photo: ' + fullPath);
        console.error(err);
        return MetadataLoader.EMPTY_METADATA;
      }
    } catch (err) {
      Logger.error(LOG_TAG, 'Error during reading photo: ' + fullPath);
      console.error(err);
      return MetadataLoader.EMPTY_METADATA;
    }
    return metadata;
  }
}
