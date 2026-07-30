/**
 * Captures process.stderr writes during Ink rendering so they don't
 * corrupt the terminal. Call release() after the Ink instance exits to
 * restore stderr and get everything that was suppressed.
 *
 * ponytail: stderr only — stdout can't be patched safely while Ink is
 * rendering (Ink holds a live reference to process.stdout and calls
 * process.stdout.write() dynamically). If SDK stdout noise surfaces,
 * thread a bypass Writable through each render() call instead.
 */
export function suppressStderr(): {release(): string} {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);

  (process.stderr as any).write = (chunk: any, enc?: any, cb?: any): boolean => {
    chunks.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };

  return {
    release(): string {
      (process.stderr as any).write = orig;
      return chunks.join('');
    },
  };
}
