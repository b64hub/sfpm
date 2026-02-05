import chalk, { ChalkInstance } from 'chalk';
import boxen from 'boxen';

export function successBox(title: string | undefined, entries: Record<string, string>): string {
    return box(title, formatLines(entries, chalk.green), 'green');
}

export function infoBox(title: string | undefined, entries: Record<string, string>): string {
    return box(title, formatLines(entries, chalk.cyan), 'cyan');
}

export function warningBox(title: string | undefined, entries: Record<string, string>): string {
    return box(title, formatLines(entries, chalk.yellow), 'yellow');
}

export function errorBox(title: string | undefined, entries: Record<string, string>): string {
    return box(title, formatLines(entries, chalk.red), 'red');
}


function formatLines(entries: Record<string, string>, color: ChalkInstance): string[] {
    const filteredEntries = Object.entries(entries).filter(([_, value]) => value !== undefined && value !== null);

    const maxKeyLength = Math.max(...filteredEntries.map(([key]) => key.length));

    const formattedLines = filteredEntries.map(([key, value]) => {
        const paddedKey = key.padEnd(maxKeyLength);
        return `${color(paddedKey)} │ ${value}`;
    });
    return formattedLines;
}


function box(title: string | undefined, lines: string[], color: string): string {
    return boxen(
        lines.join('\n'),
        {
            padding: 1,
            margin: { top: 1, bottom: 1 },
            borderStyle: 'round',
            borderColor: color,
            title: title,
            titleAlignment: 'center',
        }
    );
}