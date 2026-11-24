import { app } from 'electron';
import { join } from 'node:path';

/** All persistent state lives under the Electron userData folder. */
export const paths = {
  get dataDir(): string {
    return app.getPath('userData');
  },
  get settingsFile(): string {
    return join(paths.dataDir, 'settings.json');
  },
  get knownHostsFile(): string {
    return join(paths.dataDir, 'known-hosts.json');
  },
  /** Agent task records survive a restart: the working directory and ACP session belong to them, not to settings. */
  get agentTasksFile(): string {
    return join(paths.dataDir, 'agent-tasks.json');
  },
  get logsDir(): string {
    return join(paths.dataDir, 'logs');
  },
  get artifactsDir(): string {
    return join(paths.dataDir, 'identity');
  },
};