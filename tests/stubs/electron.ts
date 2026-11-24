import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Minimal electron surface used by main-process modules under test. */
export const app = {
  getPath: (_name: string) => join(tmpdir(), 'easyshell-unit-tests'),
  getVersion: () => '0.0.0-test',
  getLocale: () => 'en-US',
  isPackaged: false,
};

export default { app };