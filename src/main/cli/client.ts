/**
 * The thin command line client for the running app.
 *
 * `easyshell ls`, `easyshell info <id>`, `easyshell exec <id> -- <command>`
 * talk to the local control API instead of starting a second window. This is
 * what makes the app scriptable from a shell or an agent without any SDK.
 */
import type { ApiSettings } from '../../shared/types';

export interface CliOutput {
  code: number;
  text: string;
}

async function request(
  api: ApiSettings,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://${api.host}:${api.port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${api.token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Plain text answers are fine.
  }
  return { status: response.status, body };
}

export async function runCliCommand(command: string, args: string[], api: ApiSettings): Promise<CliOutput> {
  try {
    if (command === 'ls') {
      const { status, body } = await request(api, '/v1/sessions');
      if (status !== 200) return { code: 1, text: `error: ${JSON.stringify(body)}` };
      const sessions = (body as { sessions: Array<Record<string, any>> }).sessions ?? [];
      if (sessions.length === 0) return { code: 0, text: 'no sessions' };
      const lines = sessions.map((session) => {
        const endpoint = session['metadata']?.endpoint ?? {};
        return [
          session['id'],
          session['kind'],
          session['status'],
          endpoint.displayName ?? session['title'],
          endpoint.source ?? '',
        ].join('\t');
      });
      return { code: 0, text: ['ID\tKIND\tSTATUS\tENDPOINT\tSOURCE', ...lines].join('\n') };
    }

    if (command === 'info') {
      const id = args[0];
      if (!id) return { code: 2, text: 'usage: easyshell info <session-id>' };
      const { status, body } = await request(api, `/v1/sessions/${encodeURIComponent(id)}`);
      if (status !== 200) return { code: 1, text: `error: ${JSON.stringify(body)}` };
      return { code: 0, text: JSON.stringify((body as { session: unknown }).session, null, 2) };
    }

    if (command === 'probe') {
      const id = args[0];
      if (!id) return { code: 2, text: 'usage: easyshell probe <session-id>' };
      const { status, body } = await request(api, `/v1/sessions/${encodeURIComponent(id)}/probe`, { method: 'POST' });
      if (status !== 200) return { code: 1, text: `error: ${JSON.stringify(body)}` };
      return { code: 0, text: JSON.stringify((body as { metadata: unknown }).metadata, null, 2) };
    }

    if (command === 'input') {
      const [id, ...rest] = args;
      if (!id) return { code: 2, text: 'usage: easyshell input <session-id> <text>' };
      const data = rest.join(' ');
      const { status } = await request(api, `/v1/sessions/${encodeURIComponent(id)}/input`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      });
      return { code: status === 200 ? 0 : 1, text: status === 200 ? 'ok' : 'failed' };
    }

    if (command === 'exec') {
      const separator = args.indexOf('--');
      const id = separator > 0 ? args[0] : args[0];
      const commandArgs = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
      if (!id || commandArgs.length === 0) {
        return { code: 2, text: 'usage: easyshell exec <session-id> -- <command>' };
      }
      const viaFlag = args.indexOf('--via-shell');
      const via = viaFlag >= 0 ? 'shell' : 'channel';
      const { status, body } = await request(api, `/v1/sessions/${encodeURIComponent(id)}/exec`, {
        method: 'POST',
        body: JSON.stringify({ command: commandArgs.join(' '), via }),
      });
      if (status !== 200) return { code: 1, text: `error: ${JSON.stringify(body)}` };
      const result = body as { stdout: string; stderr: string; code: number | null; timedOut: boolean };
      const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd();
      return { code: result.timedOut ? 124 : (result.code ?? 0), text };
    }

    return { code: 2, text: `unknown command: ${command}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      text: `cannot reach the EasyShell control API at ${api.host}:${api.port}: ${message}`,
    };
  }
}