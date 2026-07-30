import {useStdout} from 'ink';

/** Returns the current terminal width, defaulting to 80. */
export function useTermWidth(): number {
  const {stdout} = useStdout();
  return stdout?.columns ?? 80;
}
