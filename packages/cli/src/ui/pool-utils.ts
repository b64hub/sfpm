import chalk from 'chalk';

/** Days-remaining + ISO date, or a red "Expired" badge. */
export function formatExpiry(expiry: number): string {
  const d    = new Date(expiry);
  const days = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  const date = d.toISOString().split('T')[0];
  return days <= 0 ? chalk.red(`Expired ${chalk.dim(date)}`) : `${days}d ${chalk.dim(date)}`;
}

/** Human-readable, coloured stage label. */
export function formatStage(stage?: string): string {
  switch (stage) {
  case 'Allocate': {return chalk.blue('Allocate');
  }

  case 'Assigned': {return chalk.hex('#FFA500')('Assigned');
  }

  case 'Available': {return chalk.green('Available');
  }

  case 'InProgress': {return chalk.yellow('In Progress');
  }

  default: {return stage ?? '—';
  }
  }
}

/** Ink color string for a pool stage. */
export function stageColor(stage?: string): string {
  switch (stage) {
  case 'Allocate': {return 'blue';
  }

  case 'Assigned': {return '#FFA500';
  }

  case 'Available': {return 'green';
  }

  case 'InProgress': {return 'yellow';
  }

  default: {return 'gray';
  }
  }
}
