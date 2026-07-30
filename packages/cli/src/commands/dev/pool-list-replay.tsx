import {Flags} from '@oclif/core';

import SfpmCommand from '../../sfpm-command.js';
import {poolListFixture} from '../../ui/fixtures/pool-list.js';
import {renderPoolList} from '../../ui/run-pool-list.js';

export default class DevPoolListReplay extends SfpmCommand {
  static override description = 'Render the pool list UI with fixture data (dev only)';
  static override enableJsonFlag = false;
  static override hidden = true;
  static override flags = {
    alias: Flags.string({default: 'my-devhub', description: 'DevHub alias shown in the badge'}),
    tag:   Flags.string({default: 'dev-pool',   description: 'Pool tag shown in the footer'}),
  };

  public async execute(): Promise<void> {
    const {flags} = await this.parse(DevPoolListReplay);
    const instance = renderPoolList(poolListFixture, flags.alias, flags.tag);
    await instance.waitUntilExit();
  }
}
