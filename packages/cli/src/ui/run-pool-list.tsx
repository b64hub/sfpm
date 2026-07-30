import type {PoolOrg} from '@b64hub/sfpm-orgs';
import type {Instance} from 'ink';

import {render} from 'ink';

import {PoolListApp} from './apps/PoolListApp.js';

export function renderPoolList(orgs: PoolOrg[], devhubAlias: string, tag?: string): Instance {
  return render(<PoolListApp orgs={orgs} devhubAlias={devhubAlias} tag={tag} />);
}
