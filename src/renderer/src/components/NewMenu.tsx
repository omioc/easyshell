import type { Settings } from '@shared/types';
import { useT } from '../i18n';
import { shellBrand } from '../lib/sessions';
import { DistroIcon } from './DistroIcon';
import {
  IconCmd,
  IconMonitor,
  IconPowershell,
  IconTerminal,
} from './Icons';
import { MenuRow, MenuSection } from './Overlay';

export interface NewMenuProps {
  settings: Settings;
  wslDistributions: string[];
  onOpenLocal: (profileId: string) => void;
  onOpenWsl: (distribution: string) => void;
  /** Opens the editor for a brand-new host; it lands in the Sessions list. */
  onNewConnection: () => void;
}

/**
 * The `+` menu next to 会话: launchers only, in the order people reach for them —
 * local command lines, the WSL distributions that need no setup, then remote
 * hosts. Saved hosts are deliberately absent: they are already rows in the
 * sidebar, and this menu is for starting something that does not exist yet.
 */
export function NewMenu({ settings, wslDistributions, onOpenLocal, onOpenWsl, onNewConnection }: NewMenuProps) {
  const t = useT();

  return (
    <>
      <MenuSection>{t('menu.localCli')}</MenuSection>
      {settings.shell.profiles.map((profile) => {
        const brand = shellBrand(profile);
        return (
          <MenuRow
            key={profile.id}
            icon={
              brand === 'powershell' ? (
                <IconPowershell size={16} />
              ) : brand === 'cmd' ? (
                <IconCmd size={16} />
              ) : (
                <IconTerminal size={15} />
              )
            }
            title={profile.label}
            onSelect={() => onOpenLocal(profile.id)}
          />
        );
      })}

      {wslDistributions.length > 0 ? (
        <>
          <MenuSection>{t('menu.wsl')}</MenuSection>
          {wslDistributions.map((distribution) => (
            <MenuRow
              key={distribution}
              icon={<DistroIcon distribution={distribution} size={16} />}
              title={distribution}
              onSelect={() => onOpenWsl(distribution)}
            />
          ))}
        </>
      ) : null}

      <MenuSection>{t('menu.remote')}</MenuSection>
      <MenuRow
        icon={<IconMonitor size={15} />}
        title={t('menu.newSsh')}
        testId="menu-new-ssh"
        onSelect={onNewConnection}
      />
    </>
  );
}
