/** Small, dependency-free formatters. Everything returns `null` when there is
 * nothing to show so the caller can decide which i18n fallback to use. */

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Fixed, locale-independent stamp: tabular numbers keep the column stable. */
export function formatDateTime(ts?: number): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  const date = new Date(ts);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function formatMemory(memoryMb?: number): string | null {
  if (typeof memoryMb !== 'number' || !Number.isFinite(memoryMb) || memoryMb <= 0) return null;
  if (memoryMb >= 1024) {
    const gb = memoryMb / 1024;
    return `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.round(memoryMb)} MB`;
}

export function formatPort(port?: number): string | null {
  return typeof port === 'number' && Number.isFinite(port) ? String(port) : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
