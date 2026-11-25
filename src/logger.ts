type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

// Format JSON structuré : Cloud Logging interprète `severity` et `message`.
export function log(severity: Severity, message: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ severity, message, ...extra });
  (severity === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
}

export const info = (m: string, e?: Record<string, unknown>) => log('INFO', m, e);
export const warn = (m: string, e?: Record<string, unknown>) => log('WARNING', m, e);
export const error = (m: string, e?: Record<string, unknown>) => log('ERROR', m, e);
