/** Display helpers. No API or React dependencies. */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled >= 10 || unit === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Parse a Cribl duration string (`60s`, `5m`, `2h`) into seconds. */
export function parseDurationSeconds(value: string): number | null {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return amount * multiplier;
}

export function formatDurationSeconds(seconds: number): string {
  if (seconds % 86_400 === 0 && seconds >= 86_400) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function formatTimestamp(millis: number | null): string {
  if (millis === null || !Number.isFinite(millis)) return 'unknown';
  return new Date(millis).toLocaleString();
}

/** Truncate for a table cell without hiding that truncation happened. */
export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
