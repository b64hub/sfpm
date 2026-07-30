import {Box, Text} from 'ink';

/**
 * Static badge for a connected org or DevHub.
 * Shown once in the static header — no animation needed.
 */
export function OrgBadge({alias, username}: {alias: string, username?: string}) {
  return (
    <Box gap={1} margin={1}>
      <Text color="green">●</Text>
      <Text bold>{alias}</Text>
      {username ? <Text dimColor> · {username}</Text> : ''}
    </Box>
  );
}
