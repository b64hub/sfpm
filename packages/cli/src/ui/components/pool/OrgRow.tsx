import {Box, Text} from 'ink';

import {GradientBar} from '../base/GradientBar.js';
import {rawSym} from '../../renderer-utils.js';
import {SFPM_GRADIENT} from '../../theme.js';

export type OrgPhase = 'creating' | 'deploying' | 'done' | 'failed' | 'prereqs' | 'warning';

export interface OrgRowProps {
  alias: string;
  barWidth: number;
  completedPackages: number;
  currentPackage?: string;
  currentPackageVersion?: string;
  failedPackages: number;
  phase: OrgPhase;
  totalPackages: number;
}

const ALIAS_COL = 20;

function PhaseLabel({phase}: {phase: OrgPhase}) {
  switch (phase) {
  case 'creating': return <Text dimColor>creating...</Text>;
  case 'prereqs':  return <Text dimColor>installing prerequisites...</Text>;
  default:         return null;
  }
}

/**
 * Renders a single active org row (creating / prereqs / deploying).
 * Terminal phases (done / warning / failed) are flushed via <Static> in PoolFillApp.
 */
export function OrgRow({
  alias,
  barWidth,
  completedPackages,
  currentPackage,
  currentPackageVersion,
  phase,
  totalPackages,
}: OrgRowProps) {
  const barValue = totalPackages > 0 ? Math.round((completedPackages / totalPackages) * 100) : 0;

  const aliasNode = (
    <Box width={ALIAS_COL}>
      <Text wrap="truncate">{alias}</Text>
    </Box>
  );

  return (
    <Box gap={1}>
      {/* Static dim indicator — progress bar provides the live visual */}
      <Text color="gray">{rawSym.pending}</Text>
      {aliasNode}
      {phase === 'deploying' && totalPackages > 0
        ? (
          <>
            <GradientBar gradient={SFPM_GRADIENT} value={barValue} width={barWidth} />
            <Text dimColor>{completedPackages}/{totalPackages}</Text>
            {currentPackage && (
              <Text dimColor wrap="truncate">
                {' · '}{currentPackage}{currentPackageVersion ? ` ${currentPackageVersion}` : ''}
              </Text>
            )}
          </>
        )
        : <PhaseLabel phase={phase} />
      }
    </Box>
  );
}
