import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ApplyIdentityResult, IdentityMetadata, PlatformOs } from '../../shared/types';

export interface ApplyIdentityInput {
  identity: IdentityMetadata;
  platform: PlatformOs;
  /** `process.execPath` of the running app. */
  execPath: string;
  isPackaged: boolean;
  artifactsDir: string;
}

function sanitizeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function stripExe(name: string): string {
  return name.replace(/\.exe$/i, '');
}

function parseVersion(version: string): [number, number, number, number] {
  const parts = version.split('.').map((item) => Number.parseInt(item, 10));
  const safe = (index: number): number => {
    const value = parts[index];
    return Number.isFinite(value) && value !== undefined ? Math.min(65535, Math.max(0, value)) : 0;
  };
  return [safe(0), safe(1), safe(2), safe(3)];
}

/**
 * Rewrites the PE version resource of `target`.
 *
 * This is the part a bastion whitelist actually reads: file name plus version
 * resource. No signature is involved, and none is produced.
 */
const requireCjs = createRequire(__filename);

interface ReseditModule {
  NtExecutable: any;
  NtExecutableResource: any;
  Resource: any;
}

async function loadResedit(): Promise<ReseditModule> {
  // resedit is ESM-only; its `./cjs` entry is a thin loader around a dynamic import.
  const loader = requireCjs('resedit/cjs') as { load: () => Promise<ReseditModule> };
  return loader.load();
}

async function patchWindowsVersionInfo(target: string, identity: IdentityMetadata): Promise<void> {
  const resedit = await loadResedit();
  const NtExecutable = resedit['NtExecutable'];
  const NtExecutableResource = resedit['NtExecutableResource'];
  const Resource = resedit['Resource'];

  const exe = NtExecutable.from(readFileSync(target), { ignoreCert: true });
  const resource = NtExecutableResource.from(exe);
  const lang = 1033;
  const codepage = 1200;

  const existing = Resource.VersionInfo.fromEntries(resource.entries);
  const versionInfo = existing.length > 0 ? existing[0] : Resource.VersionInfo.createEmpty();
  versionInfo.lang = lang;

  versionInfo.setStringValues(
    { lang, codepage },
    {
      CompanyName: identity.companyName,
      FileDescription: identity.fileDescription,
      FileVersion: identity.fileVersion,
      InternalName: identity.internalName,
      LegalCopyright: identity.legalCopyright,
      OriginalFilename: identity.originalFilename,
      ProductName: identity.productName,
      ProductVersion: identity.productVersion,
    },
    true,
  );

  const [fmaj, fmin, fpat, fbuild] = parseVersion(identity.fileVersion);
  versionInfo.setFileVersion(fmaj, fmin, fpat, fbuild, lang);
  const [pmaj, pmin, ppat, pbuild] = parseVersion(identity.productVersion);
  versionInfo.setProductVersion(pmaj, pmin, ppat, pbuild, lang);

  versionInfo.outputToResourceEntries(resource.entries);
  resource.outputResource(exe);
  writeFileSync(target, Buffer.from(exe.generate()));
}

/** Success payload: every result message interpolates `{path}`, so it always travels along. */
function okResult(path: string, messageKey: string, portable: boolean): ApplyIdentityResult {
  return { ok: true, path, messageKey, params: { path }, portable };
}

async function applyWindows(input: ApplyIdentityInput): Promise<ApplyIdentityResult> {
  const { identity } = input;
  const targetDir = input.isPackaged ? dirname(input.execPath) : input.artifactsDir;
  mkdirSync(targetDir, { recursive: true });
  const base = stripExe(sanitizeName(identity.alias, 'EasyShell'));
  const target = join(targetDir, `${base}.exe`);

  try {
    copyFileSync(input.execPath, target);
    await patchWindowsVersionInfo(target, identity);
  } catch (error) {
    return {
      ok: false,
      path: target,
      messageKey: 'settings.identity.result.failed',
      params: { message: error instanceof Error ? error.message : String(error) },
    };
  }

  return okResult(
    target,
    input.isPackaged ? 'settings.identity.result.ok' : 'settings.identity.result.portable',
    !input.isPackaged,
  );
}

function applyMac(input: ApplyIdentityInput): ApplyIdentityResult {
  const { identity } = input;
  const macosDir = dirname(input.execPath);
  const contentsDir = dirname(macosDir);
  const bundleDir = dirname(contentsDir);
  if (!bundleDir.endsWith('.app')) {
    return {
      ok: false,
      messageKey: 'settings.identity.result.failed',
      params: { message: 'not running from an .app bundle' },
    };
  }

  const appName = sanitizeName(identity.macBundleName || identity.alias, 'EasyShell');
  const targetBundle = join(dirname(bundleDir), `${appName}.app`);
  try {
    cpSync(bundleDir, targetBundle, { recursive: true, dereference: false });
  } catch (error) {
    return {
      ok: false,
      path: targetBundle,
      messageKey: 'settings.identity.result.failed',
      params: { message: error instanceof Error ? error.message : String(error) },
    };
  }

  const plist = join(targetBundle, 'Contents', 'Info.plist');
  if (existsSync(plist)) {
    const setValue = (key: string, value: string) => {
      try {
        execFileSync('plutil', ['-replace', key, '-string', value, plist]);
      } catch {
        // Older or locked bundles: leave the original value in place.
      }
    };
    setValue('CFBundleName', appName);
    setValue('CFBundleDisplayName', identity.productName || appName);
    setValue('CFBundleIdentifier', identity.macBundleIdentifier);
    setValue('CFBundleShortVersionString', identity.productVersion);
    setValue('CFBundleVersion', identity.fileVersion);
  }

  return okResult(targetBundle, 'settings.identity.result.ok', false);
}

function applyLinux(input: ApplyIdentityInput): ApplyIdentityResult {
  const { identity } = input;
  const targetDir = input.isPackaged ? dirname(input.execPath) : input.artifactsDir;
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, sanitizeName(identity.linuxProcessName || identity.alias, 'easyshell'));
  try {
    copyFileSync(input.execPath, target);
    chmodSync(target, 0o755);
  } catch (error) {
    return {
      ok: false,
      path: target,
      messageKey: 'settings.identity.result.failed',
      params: { message: error instanceof Error ? error.message : String(error) },
    };
  }
  return okResult(
    target,
    input.isPackaged ? 'settings.identity.result.ok' : 'settings.identity.result.portable',
    !input.isPackaged,
  );
}

export async function applyIdentity(input: ApplyIdentityInput): Promise<ApplyIdentityResult> {
  if (input.platform === 'win32') return applyWindows(input);
  if (input.platform === 'darwin') return applyMac(input);
  return applyLinux(input);
}