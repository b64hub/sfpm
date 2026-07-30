import { Text, Box } from "ink";
import {Gradient, SFPM_GRADIENT} from '../../theme.js'

/** Gradient progress bar */
export function GradientBar({gradient = SFPM_GRADIENT, value, width}: {gradient: Gradient, value: number; width: number}) {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * width);
  const lerp = (a: number, b: number, t: number) =>
    Math.round(a + (b - a) * t);

  const hex = (n: number) => n.toString(16).padStart(2, '0');

  return (
    <Box>
      {Array.from({length: width}, (_, i) => {
        if (i >= filled) return <Text key={i} dimColor>░</Text>;
        const t = width > 1 ? i / (width - 1) : 1;
        const r = lerp(gradient.start.r, gradient.end.r, t);
        const g = lerp(gradient.start.g, gradient.end.g, t);
        const b = lerp(gradient.start.b, gradient.end.b, t);
        return (
          <Text key={i} color={`#${hex(r)}${hex(g)}${hex(b)}`}>
            █
          </Text>
        );
      })}
    </Box>
  );
}