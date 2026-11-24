import type { EasyShellBridge } from '@shared/types';
import { createMockBridge } from './dev/mockBridge';

declare global {
  interface Window {
    easyshell?: EasyShellBridge;
  }
}

/**
 * The real bridge in Electron, an in-memory mock in a plain browser
 * (`npm run dev:web`). The UI never talks to `window.easyshell` directly.
 */
export function getBridge(): EasyShellBridge {
  if (window.easyshell) return window.easyshell;
  mock ??= createMockBridge();
  return mock;
}

let mock: EasyShellBridge | null = null;

export function isMockBridge(): boolean {
  return !window.easyshell;
}