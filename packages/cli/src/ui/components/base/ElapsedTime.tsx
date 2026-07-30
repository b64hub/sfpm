import {Text, useAnimation} from 'ink';

// ---- ElapsedTime ----

/**
 * Animated elapsed-time display. Re-renders every second.
 *
 * @param format   - Defaults to m:ss. Pass `formatTime` from selectors for the
 *                   package-row style ("1.5s" / "2m 30s").
 * @param color    - Ink color string (e.g. "yellow").
 * @param dimColor - Render dimmed (e.g. for the footer's total elapsed).
 */
export function ElapsedTime({
  startedAt,
  format = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },
  color,
  dimColor,
}: {
  startedAt: number;
  format?: (ms: number) => string;
  color?: string;
  dimColor?: boolean;
}) {
  useAnimation({interval: 1000});
  return <Text color={color} dimColor={dimColor}>{format(Date.now() - startedAt)}</Text>;
}