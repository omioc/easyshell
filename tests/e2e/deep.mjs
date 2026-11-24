/**
 * Deep end-to-end checks that the smoke test cannot cover:
 *   - a WSL session (POSIX shell on this machine)
 *   - shell-injection probing (plain-text marker round trip)
 *   - nested login detection growing the hop chain
 *   - identity spoofing: the written copy really carries the forged version resource
 *   - the CLI client talking to the running instance
 *
 * Requires a WSL distribution (Ubuntu by default, override with EASYSHELL_E2E_DISTRO).
 * Usage: npm run build && node tests/e2e/deep.mjs
 */
import { _electron as electron } from 'playwright';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = process.cwd();
const distro = process.env.EASYSHELL_E2E_DISTRO ?? 'Ubuntu';

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  process.stdout.write(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, EASYSHELL_E2E: '1' } });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await sleep(600);

  const bootstrap = await page.evaluate(() => globalThis.easyshell.bootstrap());
  const token = bootstrap.api.token;
  const base = bootstrap.api.baseUrl;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const hasWsl = bootstrap.wslDistributions.includes(distro);
  check(`WSL distribution "${distro}" is available`, hasWsl, bootstrap.wslDistributions.join(', '));

  if (hasWsl) {
    const session = await page.evaluate(
      (name) => globalThis.easyshell.createSession({ kind: 'wsl', distribution: name, title: 'e2e-wsl' }),
      distro,
    );
    check('WSL session created', Boolean(session?.id), session.id);

    const probed = await poll(async () => {
      const metadata = await page.evaluate((id) => globalThis.easyshell.probeSession(id), session.id);
      return metadata?.os?.hostname ? metadata : null;
    }, 25000);
    check('WSL probe reports a Linux system', Boolean(probed), probed ? `${probed.os.os} kernel=${probed.os.kernel}` : 'no data');
    check('WSL probe found the distribution name', /ubuntu|linux/i.test(probed?.os?.os ?? ''), probed?.os?.os);

    // Shell injection: run a command through the interactive shell, captured between markers.
    const injected = await (
      await fetch(`${base}/v1/sessions/${session.id}/exec`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ command: 'echo injection-ok; uname -s', via: 'shell', timeoutMs: 15000 }),
      })
    ).json();
    check(
      'shell injection captured command output',
      /injection-ok/.test(injected.stdout ?? '') && /Linux/.test(injected.stdout ?? ''),
      JSON.stringify(injected).slice(0, 160),
    );

    // Nested login: typed command must add a hop, then `exit` must remove it.
    await page.evaluate((id) => globalThis.easyshell.writeSession(id, 'ssh -p 2222 root@198.18.255.1\r'), session.id);
    const grown = await poll(async () => {
      const metadata = await page.evaluate((id) => globalThis.easyshell.getSession(id), session.id);
      const chain = metadata?.metadata?.endpoint?.chain ?? [];
      return chain.length > 1 ? chain : null;
    }, 12000);
    check('nested login adds a hop', Boolean(grown), grown ? grown.map((hop) => hop.label).join(' -> ') : 'no hop');
    check(
      'nested hop is attributed to the typed command',
      (grown ?? []).some((hop) => hop.detectedBy === 'command-line' && hop.host === '198.18.255.1'),
    );
    check(
      'endpoint switched to the nested target',
      (grown ?? []).at(-1)?.host === '198.18.255.1',
      (grown ?? []).at(-1)?.label,
    );

    await page.evaluate((id) => globalThis.easyshell.writeSession(id, '\u0003'), session.id);
    await page.evaluate((id) => globalThis.easyshell.writeSession(id, 'exit\r'), session.id);
    const shrunk = await poll(async () => {
      const metadata = await page.evaluate((id) => globalThis.easyshell.getSession(id), session.id);
      const chain = metadata?.metadata?.endpoint?.chain ?? [];
      return chain.length === 1 ? chain : null;
    }, 12000);
    check('leaving the nested session drops the hop', Boolean(shrunk), shrunk ? shrunk[0]?.label : 'still nested');

    await page.evaluate((id) => globalThis.easyshell.closeSession(id), session.id);
  }

  // ---- identity spoofing ----
  const identity = await page.evaluate(() => globalThis.easyshell.updateSettings({ identity: { alias: 'MobaXterm' } }));
  check('identity settings accepted', identity.identity.alias === 'MobaXterm');
  const applied = await page.evaluate(() => globalThis.easyshell.applyIdentity());
  check('applyIdentity reported success', applied.ok, applied.path ?? applied.messageKey);

  if (applied.ok && applied.path) {
    check('artifact exists', existsSync(applied.path), `${Math.round(statSync(applied.path).size / 1048576)} MB`);
    const resedit = await require('resedit/cjs').load();
    const exe = resedit.NtExecutable.from(readFileSync(applied.path), { ignoreCert: true });
    const resource = resedit.NtExecutableResource.from(exe);
    const infos = resedit.Resource.VersionInfo.fromEntries(resource.entries);
    const strings = infos.length > 0 ? infos[0].getStringValues({ lang: 1033, codepage: 1200 }) : {};
    check('forged ProductName is in the PE', strings.ProductName === 'MobaXterm', strings.ProductName);
    check('forged CompanyName is in the PE', strings.CompanyName === 'Mobatek', strings.CompanyName);
    check('forged FileVersion is in the PE', /^24\.2/.test(strings.FileVersion ?? ''), strings.FileVersion);
  }

  // ---- CLI client against the running instance ----
  const cliSession = await page.evaluate(async () => {
    const boot = await globalThis.easyshell.bootstrap();
    const profile = boot.settings.shell.profiles[0];
    return globalThis.easyshell.createSession({ kind: 'local', profileId: profile.id, command: profile.command, args: profile.args, title: 'cli' });
  });
  await sleep(1500);
  const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const lsCli = await execFileAsync(electronBin, ['.', 'ls'], { cwd: root }).catch((error) => ({
    stdout: String(error.stdout ?? ''),
    stderr: String(error.stderr ?? error.message),
  }));
  const cliText = String(lsCli.stdout ?? '');
  check(
    'CLI `ls` reached the running instance',
    cliText.includes('KIND') && cliText.includes(cliSession.id),
    cliText.split('\n').find((line) => line.includes(cliSession.id)) ?? cliText.slice(0, 80),
  );

  const execCli = await execFileAsync(electronBin, ['.', 'exec', cliSession.id, '--', 'echo cli-exec-ok'], { cwd: root }).catch(
    (error) => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) }),
  );
  check('CLI `exec` runs a command in a session', /cli-exec-ok/.test(String(execCli.stdout ?? '')), String(execCli.stdout ?? '').trim().slice(0, 60));
} finally {
  await app.close();
}

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.map((item) => item.name).join(', ')}\n`);
  process.exit(1);
}