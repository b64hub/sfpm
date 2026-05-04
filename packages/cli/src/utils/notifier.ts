import {execFile} from 'node:child_process';
import os from 'node:os';

/**
 * Send a cross-platform desktop notification.
 *
 * Uses `node-notifier` when available, falling back to native OS
 * commands (osascript on macOS, notify-send on Linux).
 *
 * If all methods fail, writes a terminal bell character as a last resort.
 */
export async function sendNotification(options: {message: string; title: string}): Promise<void> {
  const {message, title} = options;

  try {
    // Try node-notifier first (cross-platform)
    const notifier = await import('node-notifier');
    await new Promise<void>((resolve, reject) => {
      notifier.default.notify(
        {message, sound: true, title},
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
    return;
  } catch {
    // node-notifier not available or failed — fall back to native
  }

  try {
    await nativeNotify(title, message);
    return;
  } catch {
    // Native notification failed — fall back to bell
  }

  // Last resort: terminal bell
  process.stdout.write('\u0007');
}

/**
 * Try native OS notification commands.
 */
function nativeNotify(title: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = os.platform();

    if (platform === 'darwin') {
      execFile('osascript', [
        '-e',
        `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
      ], err => {
        if (err) reject(err);
        else resolve();
      });
    } else if (platform === 'linux') {
      execFile('notify-send', [title, message], err => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      // Windows or unknown — no native fallback
      reject(new Error(`No native notification support for ${platform}`));
    }
  });
}

function escapeAppleScript(str: string): string {
  return str.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
}
