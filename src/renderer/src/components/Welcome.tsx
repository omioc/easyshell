import { useT } from '../i18n';
import { BrandMark, IconServer, IconSliders, IconTerminal } from './Icons';

export interface WelcomeProps {
  /** App version, shown in the bottom-right corner. */
  version: string;
  onNewTerminal: () => void;
  onOpenConnections: () => void;
  onOpenSettings: () => void;
}

/**
 * First-run / no-session surface. The mark and the name share one line, and the
 * card holds the three things a terminal is opened for. Nothing else competes
 * for the eye.
 */
export function Welcome({ version, onNewTerminal, onOpenConnections, onOpenSettings }: WelcomeProps) {
  const t = useT();

  return (
    <div className="welcome" data-testid="welcome">
      <div className="welcome-inner">
        <div className="welcome-head">
          <span className="welcome-mark" aria-hidden="true">
            <BrandMark size={26} />
          </span>
          <h1 className="welcome-name">{t('app.name')}</h1>
        </div>

        <div className="welcome-card">
          <button
            type="button"
            className="welcome-row"
            data-testid="welcome-new-terminal"
            onClick={onNewTerminal}
          >
            <span className="welcome-row-icon">
              <IconTerminal size={16} />
            </span>
            <span className="welcome-row-label">{t('welcome.newTerminal')}</span>
          </button>
          <button
            type="button"
            className="welcome-row"
            data-testid="welcome-connections"
            onClick={onOpenConnections}
          >
            <span className="welcome-row-icon">
              <IconServer size={16} />
            </span>
            <span className="welcome-row-label">{t('welcome.connections')}</span>
          </button>
          <button
            type="button"
            className="welcome-row"
            data-testid="welcome-settings"
            onClick={onOpenSettings}
          >
            <span className="welcome-row-icon">
              <IconSliders size={16} />
            </span>
            <span className="welcome-row-label">{t('welcome.settings')}</span>
          </button>
        </div>

        <p className="welcome-hint">{t('welcome.hint')}</p>
      </div>

      <p className="welcome-version tnum">{t('welcome.version', { version })}</p>
    </div>
  );
}
