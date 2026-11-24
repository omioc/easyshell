import { useState } from 'react';
import type { SessionHop, SessionInfo, SessionOrigin } from '@shared/types';
import { useT } from '../i18n';
import type { TFn } from '../i18n';
import { formatDateTime, formatMemory, formatPort } from '../lib/format';
import { IconCopy, IconRefresh, IconTerminal } from './Icons';
import { InfoGroup, InfoRow } from './InfoRows';

type PanelSection = 'overview' | 'system' | 'chain' | 'raw';

const SECTIONS: Array<{ id: PanelSection; labelKey: string }> = [
  { id: 'overview', labelKey: 'sessionInfo.tab.overview' },
  { id: 'system', labelKey: 'sessionInfo.tab.system' },
  { id: 'chain', labelKey: 'sessionInfo.tab.chain' },
  { id: 'raw', labelKey: 'sessionInfo.tab.raw' },
];

function originLabel(origin: SessionOrigin, t: TFn): string {
  if (origin.type === 'ui') return t('sessionInfo.origin.ui');
  if (origin.type === 'api') return t('sessionInfo.origin.api');
  return `${t('sessionInfo.origin.cli')} \u00b7 ${origin.via}`;
}

type HopPosition = 'initial' | 'middle' | 'current';

/**
 * Where a hop sits in the chain: the machine the tab was opened on is the
 * initial session, the end of the chain is where the user is right now, and
 * everything between came after the one and before the other. A session that
 * never moved has no middle, and its only hop is the current one.
 */
function hopPosition(index: number, total: number): HopPosition {
  if (index === total - 1) return 'current';
  return index === 0 ? 'initial' : 'middle';
}

function ChainHop({
  hop,
  position,
  current,
}: {
  hop: SessionHop;
  /** Where this hop sits between the first machine and the one on screen. */
  position: HopPosition;
  /** The hop the user is on right now: the end of the chain. */
  current: boolean;
}) {
  const t = useT();
  return (
    <li className="chain-hop" data-current={current ? 'true' : undefined}>
      <span className="chain-node" aria-hidden="true" />
      <div className="chain-body">
        <div className="chain-head">
          <span className="chain-label">{hop.label}</span>
          <span className={current ? 'chain-badge chain-badge-current' : 'chain-badge'}>
            {t(`sessionInfo.hop.${position}`)}
          </span>
        </div>
        <div className="chain-meta">
          <span>
            <span className="chain-meta-key">{t('sessionInfo.host')}</span>
            {hop.host ?? t('common.none')}
          </span>
          {hop.hostname && hop.hostname !== hop.host ? (
            <span>
              <span className="chain-meta-key">{t('sessionInfo.hostname')}</span>
              {hop.hostname}
            </span>
          ) : null}
          <span>
            <span className="chain-meta-key">{t('sessionInfo.user')}</span>
            {hop.username ?? t('common.none')}
          </span>
          <span>
            <span className="chain-meta-key">{t('sessionInfo.port')}</span>
            {formatPort(hop.port) ?? t('common.none')}
          </span>
          <span>
            <span className="chain-meta-key">{t('sessionInfo.confidence')}</span>
            {t(`sessionInfo.confidence.${hop.confidence}`)}
          </span>
          <span>
            <span className="chain-meta-key">{t('sessionInfo.created')}</span>
            <span className="tnum">{formatDateTime(hop.at) ?? t('common.none')}</span>
          </span>
          <span>
            <span className="chain-meta-key">{t('sessionInfo.detectedBy')}</span>
            {t(`sessionInfo.detectedBy.${hop.detectedBy}`)}
          </span>
        </div>
      </div>
    </li>
  );
}

export interface SessionInfoPanelProps {
  /** The active terminal tab, or null when no terminal is open. */
  session: SessionInfo | null;
  onRefresh: (id: string) => Promise<void>;
  onCopyJson: (session: SessionInfo) => void;
  /** Opens a local shell: the one action the empty state can offer. */
  onNewTerminal: () => void;
}

/**
 * Body of the "terminal session" tab.
 *
 * The four sections are chips inside the body instead of a second tab row: the
 * sheet header owns the only real tabs, so this stays a secondary switch.
 */
export function SessionInfoPanel({
  session,
  onRefresh,
  onCopyJson,
  onNewTerminal,
}: SessionInfoPanelProps) {
  const t = useT();
  const [section, setSection] = useState<PanelSection>('overview');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (id: string) => {
    setRefreshing(true);
    try {
      await onRefresh(id);
    } finally {
      setRefreshing(false);
    }
  };

  if (!session) {
    return (
      <div className="info-empty-wrap">
        <div className="info-empty-card">
          <span className="info-empty-icon" aria-hidden="true">
            <IconTerminal size={26} />
          </span>
          <h3 className="info-empty-title">{t('sessionInfo.noSession')}</h3>
          <p className="info-empty-hint">{t('sessionInfo.noSessionHint')}</p>
          <button
            type="button"
            className="button button-primary info-empty-action"
            onClick={onNewTerminal}
          >
            <IconTerminal size={14} />
            {t('welcome.newTerminal')}
          </button>
        </div>
      </div>
    );
  }

  const endpoint = session.metadata.endpoint;
  const os = session.metadata.os;
  const probed = typeof os.probedAt === 'number' || Boolean(os.hostname);
  const chain = endpoint.chain;

  return (
    <>
      <div className="info-chips" role="tablist" aria-label={t('sessionInfo.title')}>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            className="info-chip"
            data-active={section === item.id ? 'true' : undefined}
            onClick={() => setSection(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      <div className="info-body">
        {section === 'overview' ? (
          <>
            <InfoGroup title={t('sessionInfo.session')}>
              <InfoRow label={t('sessionInfo.id')} value={session.id} mono />
              <InfoRow label={t('sessionInfo.kind')} value={t(`kind.${session.kind}`)} />
              <InfoRow label={t('sessionInfo.status')} value={t(`status.${session.status}`)} />
              <InfoRow label={t('sessionInfo.title_field')} value={session.title} />
              <InfoRow
                label={t('sessionInfo.created')}
                value={formatDateTime(session.createdAt)}
                mono
              />
              <InfoRow label={t('sessionInfo.origin')} value={originLabel(session.origin, t)} />
              <InfoRow
                label={t('sessionInfo.clients')}
                value={
                  session.attachedClients > 0
                    ? t('sessionInfo.attached', { count: session.attachedClients })
                    : t('sessionInfo.attachedNone')
                }
              />
              {typeof session.exitCode === 'number' ? (
                <InfoRow label={t('sessionInfo.exitCode')} value={String(session.exitCode)} mono />
              ) : null}
            </InfoGroup>
            <InfoGroup title={t('sessionInfo.location')}>
              <InfoRow label={t('sessionInfo.displayName')} value={endpoint.displayName} />
              <InfoRow label={t('sessionInfo.host')} value={endpoint.host} mono />
              {endpoint.hostname && endpoint.hostname !== endpoint.host ? (
                <InfoRow label={t('sessionInfo.hostname')} value={endpoint.hostname} mono />
              ) : null}
              <InfoRow label={t('sessionInfo.port')} value={formatPort(endpoint.port)} mono />
              <InfoRow label={t('sessionInfo.user')} value={endpoint.username} mono />
              <InfoRow label={t('sessionInfo.distribution')} value={endpoint.distribution} />
              <InfoRow label={t('sessionInfo.source')} value={t(`sessionInfo.source.${endpoint.source}`)} />
            </InfoGroup>
          </>
        ) : null}

        {section === 'system' ? (
          probed ? (
            <InfoGroup title={t('sessionInfo.system')}>
              <InfoRow label={t('sessionInfo.hostname')} value={os.hostname} />
              <InfoRow label={t('sessionInfo.os')} value={os.os} />
              <InfoRow label={t('sessionInfo.osVersion')} value={os.osVersion} />
              <InfoRow label={t('sessionInfo.kernel')} value={os.kernel} mono />
              <InfoRow label={t('sessionInfo.arch')} value={os.arch} mono />
              <InfoRow label={t('sessionInfo.shell')} value={os.shell} mono />
              <InfoRow label={t('sessionInfo.ips')} value={os.ips?.join(', ')} mono />
              <InfoRow label={t('sessionInfo.cpu')} value={os.cpuCount ? String(os.cpuCount) : null} mono />
              <InfoRow label={t('sessionInfo.memory')} value={formatMemory(os.memoryMb)} mono />
              <InfoRow label={t('sessionInfo.timezone')} value={os.timezone} />
              <InfoRow label={t('sessionInfo.probedAt')} value={formatDateTime(os.probedAt)} mono />
              <InfoRow label={t('sessionInfo.probeChannel')} value={session.probe.channel} mono />
              <InfoRow label={t('sessionInfo.probeError')} value={os.probeError} tone="danger" />
            </InfoGroup>
          ) : (
            <div className="info-empty">
              <p>{t('sessionInfo.empty')}</p>
              <button type="button" className="button" onClick={() => void refresh(session.id)}>
                <IconRefresh size={14} />
                {t('sessionInfo.refresh')}
              </button>
            </div>
          )
        ) : null}

        {section === 'chain' ? (
          <div className="info-chain">
            <h3 className="info-group-title">{t('sessionInfo.chain')}</h3>
            <ol className="chain-list">
              {chain.map((hop, index) => (
                <ChainHop
                  key={`${hop.label}-${hop.at}`}
                  hop={hop}
                  position={hopPosition(index, chain.length)}
                  current={index === chain.length - 1}
                />
              ))}
            </ol>
            {chain.length <= 1 ? (
              <div className="chain-note">
                <p>{t('sessionInfo.chainEmpty')}</p>
                <p>{t('sessionInfo.chainHint')}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {section === 'raw' ? (
          <div className="info-raw-wrap">
            <pre className="info-raw">{JSON.stringify(session, null, 2)}</pre>
          </div>
        ) : null}
      </div>

      {/* Two icon buttons: the footer is a toolbar, and the tooltip carries the
          word each one used to spell out. */}
      <footer className="info-footer">
        <button
          type="button"
          className="icon-button"
          aria-label={t('sessionInfo.refresh')}
          data-tip={t('sessionInfo.refresh')}
          onClick={() => void refresh(session.id)}
          disabled={refreshing}
          aria-busy={refreshing ? 'true' : undefined}
        >
          <IconRefresh size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('sessionInfo.copyJson')}
          data-tip={t('sessionInfo.copyJson')}
          onClick={() => onCopyJson(session)}
        >
          <IconCopy size={14} />
        </button>
      </footer>
    </>
  );
}
