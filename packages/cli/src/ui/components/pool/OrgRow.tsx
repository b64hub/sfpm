import {Box, Text} from 'ink';

import {GradientBar} from '../base/GradientBar.js';
import {rawSym} from '../../renderer-utils.js';
import {SFPM_GRADIENT} from '../../theme.js';

export type OrgPhase = 'creating' | 'deploying' | 'done' | 'failed' | 'prereqs' | 'warning';

export interface OrgRowProps {
  alias: string;
  /** Required for active phases; omit for terminal phases (no bar rendered). */
  barWidth?: number;
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
 * Single org row — used in both the live area (during provisioning) and the
 * static flush (at the end). Handles all phases so both contexts share one renderer.
 */
export function OrgRow({
  alias,
  barWidth = 20,
  completedPackages,
  currentPackage,
  currentPackageVersion,
  failedPackages,
  phase,
  totalPackages,
}: OrgRowProps) {
  const barValue = totalPackages > 0 ? Math.round((completedPackages / totalPackages) * 100) : 0;

  const aliasNode = (
    <Box width={ALIAS_COL}>
      <Text wrap="truncate">{alias}</Text>
    </Box>
  );

  // ── Terminal phases ───────────────────────────────────────────────────────
  if (phase === 'done' || phase === 'warning' || phase === 'failed') {
    const icon    = phase === 'done' ? rawSym.success : phase === 'warning' ? '⚠' : rawSym.fail;
    const color   = phase === 'done' ? 'green' : phase === 'warning' ? 'yellow' : 'red';
    const summary = phase === 'failed'
      ? (totalPackages > 0 ? `failed · ${completedPackages}/${totalPackages} packages` : 'failed')
      : failedPackages > 0
        ? `${completedPackages - failedPackages}/${totalPackages} packages · ${failedPackages} failed`
        : `${completedPackages}/${totalPackages} packages`;

    return (
      <Box gap={1}>
        <Text color={color}>{icon}</Text>
        {aliasNode}
        <Text dimColor>{summary}</Text>
      </Box>
    );
  }

  // ── Active phases ─────────────────────────────────────────────────────────
  return (
    <Box gap={1}>
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
