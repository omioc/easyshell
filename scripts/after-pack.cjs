/**
 * Finalises the packed macOS bundle: declares extra URL schemes, then ad-hoc
 * signs the result.
 *
 * Schemes: `electron-builder.yml` declares the defaults (`sso`, `easyshell`).
 * macOS only routes a URL to an app that declared its scheme at build time, so a
 * bastion whose link uses another scheme needs it here — either edit the yml or,
 * without touching any file, pack once with
 *
 *   EASYSHELL_URL_SCHEMES="usm,jumpserver" npm run dist:mac
 *
 * Signing: there is no Developer ID certificate on a local machine and
 * electron-builder is configured with `identity: null`, so nothing would sign the
 * app. Apple Silicon requires every executable page to be covered by a signature,
 * and packaging rewrites Info.plist (which is what this hook just did again),
 * invalidating the signature Electron ships with. `codesign --sign -` produces a
 * valid ad-hoc signature that Gatekeeper accepts for a locally built app (no
 * quarantine attribute, no notarization).
 *
 * Runs before the dmg is created, so the installer carries both the extra schemes
 * and the signature.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

/** The schemes already declared by `electron-builder.yml`. */
function declaredSchemes(plist) {
  try {
    const printed = execFileSync(
      PLIST_BUDDY,
      ['-c', 'Print :CFBundleURLTypes:0:CFBundleURLSchemes', plist],
      { encoding: 'utf8' },
    );
    return printed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== 'Array {' && line !== '}');
  } catch {
    return null;
  }
}

/** Adds the schemes named by EASYSHELL_URL_SCHEMES, keeping the existing ones. */
function addExtraSchemes(plist) {
  const extra = (process.env.EASYSHELL_URL_SCHEMES || '')
    .split(/[\s,]+/)
    .map((scheme) => scheme.trim().toLowerCase().replace(/:\/\/.*$/, ''))
    .filter(Boolean);
  if (extra.length === 0) return;

  const existing = declaredSchemes(plist);
  if (existing === null) {
    console.warn('[after-pack] no CFBundleURLTypes in Info.plist; extra schemes skipped');
    return;
  }
  let index = existing.length;
  for (const scheme of extra) {
    if (existing.includes(scheme)) continue;
    execFileSync(
      PLIST_BUDDY,
      ['-c', `Add :CFBundleURLTypes:0:CFBundleURLSchemes:${index} string ${scheme}`, plist],
      { stdio: 'inherit' },
    );
    existing.push(scheme);
    index += 1;
    console.log(`[after-pack] declared URL scheme ${scheme}://`);
  }
}

// Exported for a smoke test of the scheme injection without packing a bundle.
exports.addExtraSchemes = addExtraSchemes;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  addExtraSchemes(path.join(appPath, 'Contents', 'Info.plist'));

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
