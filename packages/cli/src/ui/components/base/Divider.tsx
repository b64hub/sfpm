import {Box, Text} from 'ink';



export function Divider({label, width}: {label?: string, width?: number} = {width: 40}) {
  const line = <Box flexGrow={1} borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderDimColor maxWidth={width} />;

  if (!label) return line;
  return (
    <Box gap={1}>
      <Text dimColor>{label}</Text>
      {line}
    </Box>
  );
}
