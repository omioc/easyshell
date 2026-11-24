import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const exe = join(process.cwd(), 'release', 'win-unpacked', 'EasyShell.exe');
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ executablePath: exe, args: [], cwd: dirname(exe) });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await new Promise((r) => setTimeout(r, 1200));
  check('packaged app boots a window', true);
  check('renderer loaded from asar', (await page.locator('#root').count()) === 1);
  const boot = await page.evaluate(() => globalThis.easyshell.bootstrap());
  check('preload bridge works in the packaged app', typeof boot?.settings === 'object');
  check('isPackaged is true', boot.platform.isPackaged === true);
  const packedLogo = await page
    .locator('[data-testid="brand-mark"]')
    .first()
    .evaluate((img) => ({
      loaded: img.complete && img.naturalWidth > 0,
      source: img.getAttribute('src') ?? '',
    }));
  check('the app logo renders inside the packaged app', packedLogo.loaded, packedLogo.source.slice(0, 48));
  check('launchPath points at the packaged exe', boot.platform.launchPath.toLowerCase() === exe.toLowerCase(), boot.platform.launchPath);

  // ---- icons: the packaged app must carry its own icon everywhere ----
  const iconInResources = join(dirname(exe), 'resources', 'icon.png');
  check('runtime icon ships next to the app (window/taskbar)', existsSync(iconInResources), iconInResources);
  const resedit = await require('resedit/cjs').load();
  const iconSet = (file) => {
    const pe = resedit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
    const res = resedit.NtExecutableResource.from(pe);
    const group = resedit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
    const bins = res.entries
      .filter((entry) => entry.type === 3)
      .map((entry) => Buffer.from(entry.bin))
      .sort((a, b) => a.length - b.length);
    const hash = createHash('sha256');
    for (const bin of bins) hash.update(bin);
    return {
      sizes: (group?.icons ?? []).map((icon) => `${icon.width}x${icon.height}`),
      hash: hash.digest('hex'),
    };
  };
  const appIcon = iconSet(exe);
  const electronIcon = iconSet(join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'));
  check(
    "the executable carries our icon, not Electron's",
    appIcon.hash !== electronIcon.hash && appIcon.sizes.length >= 6,
    `${appIcon.sizes.length} sizes: ${appIcon.sizes.join(',')}`,
  );
  check(
    'the icon set has the sizes Windows asks for',
    ['16x16', '24x24', '32x32', '48x48', '128x128'].every((size) => appIcon.sizes.includes(size)),
    appIcon.sizes.join(','),
  );
  const applied = await page.evaluate(() => globalThis.easyshell.applyIdentity());
  check('applyIdentity succeeds in the packaged app', applied.ok, `${applied.path ?? ''} ${applied.messageKey}`);
  check('artifact is written beside the installed exe', applied.path ? dirname(applied.path).toLowerCase() === dirname(exe).toLowerCase() : false, applied.path);
  check('artifact name follows the alias', applied.path ? applied.path.endsWith('MobaXterm.exe') : false);
  check('the identity copy inherits the app icon', iconSet(applied.path).hash === appIcon.hash);
  if (applied.ok && applied.path && existsSync(applied.path)) {
    check('artifact is launchable size', statSync(applied.path).size > 50_000_000, `${Math.round(statSync(applied.path).size / 1048576)} MB`);
    const resedit = await require('resedit/cjs').load();
    const pe = resedit.NtExecutable.from(readFileSync(applied.path), { ignoreCert: true });
    const res = resedit.NtExecutableResource.from(pe);
    const strings = resedit.Resource.VersionInfo.fromEntries(res.entries)[0].getStringValues({ lang: 1033, codepage: 1200 });
    check('forged CompanyName', strings.CompanyName === 'Mobatek', strings.CompanyName);
    check('forged ProductName', strings.ProductName === 'MobaXterm', strings.ProductName);
  }
  await page.screenshot({ path: join(process.cwd(), '.e2e', 'packaged.png') });
} finally {
  await app.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exit(1);