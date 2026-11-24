import type { ReactNode } from 'react';
import type { SessionStatus } from '@shared/types';
import { useT } from '../i18n';

/** Label-left / value-right row used across the info panel and About. */
export function InfoRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  tone?: 'danger' | 'muted';
}) {
  const t = useT();
  const shown = value && value.length > 0 ? value : null;
  return (
    <div className="info-row">
      <dt className="info-key">{label}</dt>
      <dd
        className="info-value"
        data-mono={mono ? 'true' : undefined}
        data-empty={shown ? undefined : 'true'}
        data-tone={tone}
      >
        {shown ?? t('common.none')}
      </dd>
    </div>
  );
}

export function InfoGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="info-group">
      <h3 className="info-group-title">{title}</h3>
      <dl className="info-list">{children}</dl>
    </section>
  );
}

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className="status-dot" data-status={status} aria-hidden="true" />;
}