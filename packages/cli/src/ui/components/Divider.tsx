import {Box, Text} from 'ink';

const line = <Box flexGrow={1} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderDimColor maxWidth={40} />;

export function Divider({label}: {label?: string} = {}) {
  if (!label) return line;
  return (
    <Box gap={1}>
      <Text dimColor>{label}</Text>
      {line}
    </Box>
  );
}
