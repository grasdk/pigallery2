import {IConfigClass} from 'typeconfig/common';
import {Config, PrivateConfigClass} from '../../../common/config/private/Config';
import {ConfigClassBuilder} from 'typeconfig/node';
import {IExtensionConfig} from './IExtension';
import {ObjectManagers} from '../ObjectManagers';
import {ServerExtensionsEntryConfig} from '../../../common/config/private/subconfigs/ServerExtensionsConfig';

/**
 * Wraps to original config and makes sure all extension related config is loaded
 */
export class ExtensionConfigWrapper {
  static async original(): Promise<PrivateConfigClass & IConfigClass> {
    const pc = ConfigClassBuilder.attachPrivateInterface(new PrivateConfigClass());
    try {
      await pc.load(); // loading the basic configs but we do not know the extension config hierarchy yet
      if (ObjectManagers.isReady()) {
        for (const ext of Object.values(ObjectManagers.getInstance().ExtensionManager.extObjects)) {
          ext.config.loadToConfig(ConfigClassBuilder.attachPrivateInterface(pc));
        }
      }
      await pc.load(); // loading the extension related configs
    } catch (e) {
      console.error('Error during loading original config. Reverting to defaults.');
      console.error(e);
    }
    return pc;
  }
}

export class ExtensionConfig<C> implements IExtensionConfig<C> {
  public template: new() => C;

  constructor(private readonly extensionFolder: string) {
  }

  private findConfig(config: PrivateConfigClass): ServerExtensionsEntryConfig {
      let c = (config.Extensions.extensions || []).find(e => e.path === this.extensionFolder);
      if (!c) {
        c = new ServerExtensionsEntryConfig(this.extensionFolder);
        config.Extensions.extensions.push(c);
      }
      return c;

  }

  public getConfig(): C {
    return this.findConfig(Config).configs as C;
  }

  public setTemplate(template: new() => C): void {
    this.template = template;
    this.loadToConfig(Config);
  }

  loadToConfig(config: PrivateConfigClass) {
    if (!this.template) {
      return;
    }

    const confTemplate = ConfigClassBuilder.attachPrivateInterface(new this.template());
    const extConf = this.findConfig(config);
    extConf.configs = confTemplate;
  }
}
