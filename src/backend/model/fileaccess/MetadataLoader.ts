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
import { ExifParserFactory, OrientationTypes } from 'ts-exif-parser';
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
                }              }
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
    size: {width: 1, height: 1},
    creationDate: 0,
    fileSize: 0,
  };

  @ExtensionDecorator(e => e.gallery.MetadataLoader.loadPhotoMetadata)
  public static async loadPhotoMetadata(fullPath: string): Promise<PhotoMetadata> {
    let fileHandle: FileHandle;
    const metadata: PhotoMetadata = {
      size: {width: 1, height: 1},
      creationDate: 0,
      fileSize: 0,
    };
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

        try {
          const exif = ExifParserFactory.create(data).parse();
          if (
            exif.tags.ISO ||
            exif.tags.Model ||
            exif.tags.Make ||
            exif.tags.FNumber ||
            exif.tags.ExposureTime ||
            exif.tags.FocalLength ||
            exif.tags.LensModel
          ) {
            if (exif.tags.Model && exif.tags.Model !== '') {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.model = '' + exif.tags.Model;
            }
            if (exif.tags.Make && exif.tags.Make !== '') {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.make = '' + exif.tags.Make;
            }
            if (exif.tags.LensModel && exif.tags.LensModel !== '') {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.lens = '' + exif.tags.LensModel;
            }
            if (Utils.isUInt32(exif.tags.ISO)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.ISO = parseInt('' + exif.tags.ISO, 10);
            }
            if (Utils.isFloat32(exif.tags.FocalLength)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.focalLength = parseFloat(
                '' + exif.tags.FocalLength
              );
            }
            if (Utils.isFloat32(exif.tags.ExposureTime)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.exposure = parseFloat(
                parseFloat('' + exif.tags.ExposureTime).toFixed(6)
              );
            }
            if (Utils.isFloat32(exif.tags.FNumber)) {
              metadata.cameraData = metadata.cameraData || {};
              metadata.cameraData.fStop = parseFloat(
                parseFloat('' + exif.tags.FNumber).toFixed(2)
              );
            }
          }
          if (
            !isNaN(exif.tags.GPSLatitude) ||
            exif.tags.GPSLongitude ||
            exif.tags.GPSAltitude
          ) {
            metadata.positionData = metadata.positionData || {};
            metadata.positionData.GPSData = {};

            if (Utils.isFloat32(exif.tags.GPSLongitude)) {
              metadata.positionData.GPSData.longitude = parseFloat(
                exif.tags.GPSLongitude.toFixed(6)
              );
            }
            if (Utils.isFloat32(exif.tags.GPSLatitude)) {
              metadata.positionData.GPSData.latitude = parseFloat(
                exif.tags.GPSLatitude.toFixed(6)
              );
            }
          }
          if (
            exif.tags.CreateDate ||
            exif.tags.DateTimeOriginal ||
            exif.tags.ModifyDate
          ) {
            metadata.creationDate =
              (exif.tags.DateTimeOriginal ||
                exif.tags.CreateDate ||
                exif.tags.ModifyDate) * 1000;
          }
          if (exif.imageSize) {
            metadata.size = {
              width: exif.imageSize.width,
              height: exif.imageSize.height,
            };
          } else if (
            exif.tags.RelatedImageWidth &&
            exif.tags.RelatedImageHeight
          ) {
            metadata.size = {
              width: exif.tags.RelatedImageWidth,
              height: exif.tags.RelatedImageHeight,
            };
          } else if (
            exif.tags.ImageWidth &&
            exif.tags.ImageHeight
          ) {
            metadata.size = {
              width: exif.tags.ImageWidth,
              height: exif.tags.ImageHeight,
            };
          } else {
            const info = imageSize(fullPath);
            metadata.size = {width: info.width, height: info.height};
          }
        } catch (err) {
          Logger.debug(LOG_TAG, 'Error parsing exif', fullPath, err);
        try {
            const info = imageSize(fullPath);
            metadata.size = {width: info.width, height: info.height};
          } catch (e) {
            metadata.size = {width: 1, height: 1};
          }
        }

        try {
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

        if (!metadata.creationDate) {
          // creationDate can be negative, when it was created before epoch (1970)
          metadata.creationDate = 0;
        }

        try {
          const exifrOptions = {
            tiff: true,
            xmp: true,
            icc: false,
            jfif: false, //not needed and not supported for png
            ihdr: true,
            iptc: false, //exifr reads UTF8-encoded data wrongly
            exif: true,
            gps: true,
            translateValues: false, //don't translate orientation from numbers to strings etc.
            mergeOutput: false //don't merge output, because things like Microsoft Rating (percent) and xmp.rating will be merged
        };
        
        const exif = await exifr.parse(data, exifrOptions);
          if (exif.xmp && exif.xmp.Rating) {
            metadata.rating = exif.xmp.Rating;
            if (metadata.rating < 0) {
              metadata.rating = 0;
            }
          }
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
          let orientation = OrientationTypes.TOP_LEFT;
          if (exif.ifd0 &&
            exif.ifd0.Orientation) {
            orientation = parseInt(
              exif.ifd0.Orientation as any,
              10
            ) as number;
          }
          if (OrientationTypes.BOTTOM_LEFT < orientation) {
            // noinspection JSSuspiciousNameCombination
            const height = metadata.size.width;
            // noinspection JSSuspiciousNameCombination
            metadata.size.width = metadata.size.height;
            metadata.size.height = height;
          }

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
                  if (OrientationTypes.BOTTOM_LEFT < orientation) {
                    [x, y] = [y, x];
                    [w, h] = [h, w];
                  }
                  let swapX = 0;
                  let swapY = 0;
                  switch (orientation) {
                    case OrientationTypes.TOP_RIGHT:
                    case OrientationTypes.RIGHT_TOP:
                      swapX = 1;
                      break;
                    case OrientationTypes.BOTTOM_RIGHT:
                    case OrientationTypes.RIGHT_BOTTOM:
                      swapX = 1;
                      swapY = 1;
                      break;
                    case OrientationTypes.BOTTOM_LEFT:
                    case OrientationTypes.LEFT_BOTTOM:
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


                faces.push({name, box});
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
