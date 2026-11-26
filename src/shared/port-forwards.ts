import type { SshPortForward } from './types';

export interface PortForwardIssue {
  index: number;
  field: keyof SshPortForward;
  key: string;
}

export function normalizeForwardHost(value: string): string {
  const host = value.trim();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Preserve invalid entries for validation instead of silently losing a tunnel. */
export function normalizePortForwards(value: unknown): SshPortForward[] | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map((item) => {
    const rule = item && typeof item === 'object' ? item : {};
    return {
      mode: rule.mode,
      bindHost: typeof rule.bindHost === 'string' ? normalizeForwardHost(rule.bindHost) : '',
      bindPort: typeof rule.bindPort === 'number' ? rule.bindPort : Number(rule.bindPort),
      targetHost: typeof rule.targetHost === 'string' ? normalizeForwardHost(rule.targetHost) : '',
      targetPort: typeof rule.targetPort === 'number' ? rule.targetPort : Number(rule.targetPort),
    };
  });
}

export function validatePortForwards(value: unknown): PortForwardIssue[] {
  if (value === undefined) return [];
  const issues: PortForwardIssue[] = [];
  const listeners = new Set<string>();
  const rules = Array.isArray(value) ? value : [value];
  rules.forEach((item, index) => {
    const rule = item && typeof item === 'object' ? item : {};
    if (rule.mode !== 'local' && rule.mode !== 'remote') {
      issues.push({ index, field: 'mode', key: 'connections.forwardModeInvalid' });
    }
    for (const field of ['bindHost', 'targetHost'] as const) {
      const host = typeof rule[field] === 'string' ? normalizeForwardHost(rule[field]) : '';
      if (!host || /[\s/\\\[\]\x00]/.test(host)) {
        issues.push({ index, field, key: 'connections.forwardHostRequired' });
      }
    }
    for (const field of ['bindPort', 'targetPort'] as const) {
      if (!Number.isInteger(rule[field]) || rule[field] < 1 || rule[field] > 65535) {
        issues.push({ index, field, key: 'connections.forwardPortInvalid' });
      }
    }
    const listener = `${rule.mode}|${normalizeForwardHost(String(rule.bindHost)).toLowerCase()}|${rule.bindPort}`;
    if (listeners.has(listener)) {
      issues.push({ index, field: 'bindPort', key: 'connections.forwardDuplicate' });
    }
    listeners.add(listener);
  });
  return issues;
}

export function forwardEndpoint(host: string, port: number): string {
  const normalized = normalizeForwardHost(host);
  return `${normalized.includes(':') ? `[${normalized}]` : normalized}:${port || ''}`;
}

/**
 * What one tunnel needs to be readable in one line: `-L 127.0.0.1:21380 →
 * 127.0.0.1:21380`. The editor prints it under the form, and a failure toast
 * names the tunnel with it, so both describe the same thing the same way.
 */
export function forwardRuleLabel(rule: SshPortForward): string {
  const flag = rule.mode === 'remote' ? '-R' : '-L';
  return `${flag} ${forwardEndpoint(rule.bindHost, rule.bindPort)} → ${forwardEndpoint(rule.targetHost, rule.targetPort)}`;
}

/**
 * A tunnel that did not come up.
 *
 * Kept apart from a connection error on purpose: the session is connected and
 * usable, and only the tunnel is broken, so the answer is a toast and never the
 * tab's status.
 */
export interface PortForwardFailure {
  /** The rule, as `forwardRuleLabel()` writes it. */
  rule: string;
  /** Why it did not come up, in the transport's own words. */
  detail: string;
}
