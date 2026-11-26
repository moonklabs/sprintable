'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { canGrantProjectAccess } from '@/lib/project-access-role';
import { CardFrame } from './card-frame';
import { fetchDeploySummary, placeAgent, takeAgentOut, type DeploySummary, type DeployWrite, type DeployWriteResult } from './deploy-access';
import { useCardRead } from './use-card-read';

/**
 * story 5034 (C4 step 3b) — «넣기 · 빼기» of ONE agent in the CURRENT project (the card's reference is the agent's member id): placed = the agent has access to this project; taken out = that access is
 * taken back (project-wide only — never an org-wide deactivation). Read and written for THE VIEWER through the web's own project-access routes; a button is drawn only when the viewer's role may use it
 * (an org owner/admin — `canGrantProjectAccess`, the same judgement as the settings screens) AND the access list was readable, and the SERVER still decides every press (403 otherwise).
 * A viewer who may not manage access sees the agent's name and nothing to press.
 */
export function DeployCard({ agentId }: { agentId: string }) {
  const ctx = useDashboardContext() as { projectId?: string | null; role?: string | null };
  const projectId = ctx.projectId ?? null;
  const mayRead = canGrantProjectAccess(ctx.role);
  const { read, retry } = useCardRead(`deploy:${agentId}:${projectId ?? ''}:${mayRead}`, () => fetchDeploySummary(agentId, projectId, mayRead));
  // what the last write made true (its own answer) — shown at once; a read that follows may still see the rows as they were (a press is a write the server has confirmed, not a guess)
  const [appliedFor, setApplied] = useState<{ base: DeploySummary; next: Pick<DeploySummary, 'access' | 'recordId'> } | null>(null);
  if (read.state !== 'ready') return <CardFrame state={read.state} onRetry={retry} data-testid="chat-card-deploy" />;
  // valid only for the very read it was made on: ANY newer read (another agent or project, a retry, coming back to this card) is fresher than a press and replaces it
  const applied = appliedFor && appliedFor.base === read.value ? appliedFor.next : null;
  const summary: DeploySummary = applied ? { ...read.value, ...applied } : read.value;
  return (
    <DeployCardFace
      key={`${summary.access}:${summary.recordId ?? ''}`}
      summary={summary}
      canAct={mayRead && projectId !== null}
      projectId={projectId}
      agentId={agentId}
      onChanged={(next) => { if (next) setApplied({ base: read.value, next }); else { setApplied(null); retry(); } }}
    />
  );
}

type Phase = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'busy' } | { kind: 'error'; why: Exclude<DeployWriteResult, 'ok'> };

export function DeployCardFace({ summary, canAct, projectId, agentId, onChanged, actions }: { summary: DeploySummary; canAct: boolean; projectId: string | null; agentId: string; onChanged: (next: DeployWrite['applied']) => void; /** the two writes — the real project-access calls by default; the state showcase passes local stand-ins (no network) */ actions?: { place: () => Promise<DeployWrite>; takeOut: () => Promise<DeployWrite> } }) {
  const t = useTranslations('chats');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'busy';
  const act = async (run: () => Promise<DeployWrite>) => {
    if (busy) return; // one press at a time
    setPhase({ kind: 'busy' });
    const r = await run();
    if (r.result === 'ok') { setPhase({ kind: 'idle' }); onChanged(r.applied); } else setPhase({ kind: 'error', why: r.result });
  };
  const buttons = canAct && summary.access !== 'unknown' && projectId !== null;
  const errorText = phase.kind === 'error' ? (phase.why === 'forbidden' ? t('deployErrForbidden') : phase.why === 'invalid' ? t('deployErrInvalid') : t('deployErrFault')) : null;
  return (
    <CardFrame state="ready" data-testid="chat-card-deploy">
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 break-words text-ds-body font-medium text-ds-ink line-clamp-2">{summary.name ?? agentId}</span>
          {!summary.active ? <Chip>{t('deployInactive')}</Chip> : null}
          {summary.access === 'granted' ? <Chip tone="done">{t('deployPlaced')}</Chip> : summary.access === 'none' ? <Chip>{t('deployNotPlaced')}</Chip> : null}
        </div>
        {buttons && phase.kind !== 'confirm' ? (
          <div className="flex flex-wrap items-center gap-2">
            {summary.access === 'none' && summary.active ? (
              <Button variant="primary" loading={busy} disabled={busy} onClick={() => void act(actions?.place ?? (() => placeAgent(projectId!, agentId)))}>{t('deployAllow')}</Button>
            ) : null}
            {summary.access === 'granted' && summary.recordId ? (
              <Button variant="secondary" disabled={busy} onClick={() => setPhase({ kind: 'confirm' })}>{t('deployRevoke')}</Button>
            ) : null}
          </div>
        ) : null}
        {buttons && phase.kind === 'confirm' && summary.recordId ? (
          <div className="flex flex-col gap-2" role="group" aria-label={t('deployRevoke')}>
            <p className="m-0 text-ds-small text-ds-ink-2">{t('deployRevokeAsk')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" onClick={() => void act(actions?.takeOut ?? (() => takeAgentOut(projectId!, summary.recordId!)))}>{t('deployRevokeYes')}</Button>
              <Button variant="quiet" onClick={() => setPhase({ kind: 'idle' })}>{t('deployRevokeNo')}</Button>
            </div>
          </div>
        ) : null}
        {errorText ? <p role="alert" className="m-0 text-ds-small text-ds-failed">{errorText}</p> : null}
      </div>
    </CardFrame>
  );
}
