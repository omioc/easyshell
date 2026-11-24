import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyIdentity } from '../../src/main/identity/spoof';
import { createDefaultSettings } from '../../src/shared/defaults';
import { translate } from '../../src/shared/i18n';

/**
 * The result messages carry a `{path}` placeholder, so a success payload without
 * `params.path` renders literally as "written to {path}". The Linux branch is the
 * one that can be exercised without a real PE resource or an .app bundle.
 */
describe('applyIdentity result payload', () => {
  let workDir: string;
  let execPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'easyshell-identity-'));
    execPath = join(workDir, 'EasyShell');
    writeFileSync(execPath, 'placeholder-binary');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const apply = (isPackaged: boolean) => {
    const { identity } = createDefaultSettings('linux');
    return applyIdentity({
      identity,
      platform: 'linux',
      execPath,
      isPackaged,
      artifactsDir: join(workDir, 'artifacts'),
    });
  };

  it('reports the artifact path as a message parameter', async () => {
    const result = await apply(true);

    expect(result.ok).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.params?.path).toBe(result.path);
  });

  it('interpolates the placeholder in the rendered message', async () => {
    const result = await apply(true);
    const message = translate('zh', result.messageKey, result.params);

    expect(message).not.toContain('{path}');
    expect(message).toContain(result.path ?? '');
  });

  it('writes the renamed copy next to the executable when packaged', async () => {
    const result = await apply(true);

    expect(result.messageKey).toBe('settings.identity.result.ok');
    expect(result.portable).toBe(false);
    expect(result.path).toBe(join(workDir, 'mobaxterm'));
    expect(readFileSync(result.path as string, 'utf8')).toBe('placeholder-binary');
  });

  it('marks an unpackaged copy as portable and says so', async () => {
    const result = await apply(false);
    const message = translate('en', result.messageKey, result.params);

    expect(result.portable).toBe(true);
    expect(result.messageKey).toBe('settings.identity.result.portable');
    expect(message).not.toContain('{path}');
    expect(message).toContain(result.path ?? '');
  });
});
