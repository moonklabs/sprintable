'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { CardFrame } from './card-frame';
import { fetchAgentAction, pressAgentAction, type AgentActionView } from './agent-action-access';
import { useCardRead } from './use-card-read';

/**
 * story 5041 — the card of an agent's ask: «스프린트를 닫아도 될까요?» An agent may not do a delete / a close / a grant on its own; the server kept the ask, and THIS card is where a person decides.
 * Pressing «승인» makes the server run the same call under the pressing person's own name and rights (so a person who may not do it on screen gets a plain line and the ask stays open for the next
 * one) — the card never decides who may press, it only shows what the server says. Read for the viewer from the request itself (never from the message), so it is never stale: a second person
 * opening it sees who decided and how it ended.
 */
export function AgentActionCard({ requestId }: { requestId: string }) {
  const { read, retry } = useCardRead(`agent-action:${requestId}`, () => fetchAgentAction(requestId));
  // what the last press answered — it is the server's own picture, shown at once; valid only for the read it was made on
  const [pressed, setPressed] = useState<{ base: AgentActionView; view: AgentActionView } | null>(null);
  if (read.state !== 'ready') return <CardFrame state={read.state} onRetry={retry} data-testid="chat-card-agent-action" />;
  const view = pressed && pressed.base === read.value ? pressed.view : read.value;
  return <AgentActionCardFace key={view.state} view={view} requestId={requestId} onPressed={(next) => setPressed({ base: read.value, view: next })} onSettled={() => { setPressed(null); retry(); }} />;
}

type Phase = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'busy' } | { kind: 'error'; why: 'forbidden' | 'fault' };

export function AgentActionCardFace({ view, requestId, onPressed, onSettled }: { view: AgentActionView; requestId: string; onPressed: (next: AgentActionView) => void; onSettled: () => void }) {
  const t = useTranslations('chats');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'busy';
  const press = async (decision: 'approve' | 'reject') => {
    if (busy) return; // one press at a time
    setPhase({ kind: 'busy' });
    const r = await pressAgentAction(requestId, decision);
    if (r.result === 'ok') { setPhase({ kind: 'idle' }); onPressed(r.view); return; }
    if (r.result === 'settled') { setPhase({ kind: 'idle' }); onSettled(); return; }
    setPhase({ kind: 'error', why: r.result });
  };
  const open = view.state === 'pending';
  const outcome = outcomeLine(t, view);
  return (
    <CardFrame state="ready" data-testid="chat-card-agent-action">
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 break-words text-ds-body font-medium text-ds-ink line-clamp-3">{view.title}</span>
          <StateChip t={t} view={view} />
        </div>
        <p className="m-0 min-w-0 break-words text-ds-small text-ds-ink-2">{view.prompt}</p>
        {view.requestedBy ? <p className="m-0 min-w-0 break-words text-ds-small text-ds-ink-3">{t('agentActionAskedBy', { name: view.requestedBy })}</p> : null}
        {open && phase.kind !== 'confirm' ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => (view.irreversible ? setPhase({ kind: 'confirm' }) : void press('approve'))}>{t('agentActionApprove')}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void press('reject')}>{t('agentActionReject')}</Button>
          </div>
        ) : null}
        {open && phase.kind === 'confirm' ? (
          <div className="flex flex-col gap-2" role="group" aria-label={t('agentActionApprove')}>
            <p className="m-0 text-ds-small text-ds-ink-2">{t('agentActionConfirmAsk')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" onClick={() => void press('approve')}>{t('agentActionConfirmYes')}</Button>
              <Button variant="quiet" onClick={() => setPhase({ kind: 'idle' })}>{t('agentActionConfirmNo')}</Button>
            </div>
          </div>
        ) : null}
        {open ? <p className="m-0 text-ds-small text-ds-ink-3">{t('agentActionPendingHint')}</p> : null}
        {outcome ? <p className="m-0 min-w-0 break-words text-ds-small text-ds-ink-2">{outcome}</p> : null}
        {phase.kind === 'error' ? <p role="alert" className="m-0 text-ds-small text-ds-failed">{phase.why === 'forbidden' ? t('agentActionErrForbidden') : t('agentActionErrFault')}</p> : null}
      </div>
    </CardFrame>
  );
}

type T = ReturnType<typeof useTranslations>;

function StateChip({ t, view }: { t: T; view: AgentActionView }) {
  if (view.state === 'pending') return <Chip>{t('agentActionStatePending')}</Chip>;
  if (view.state === 'running') return <Chip>{t('agentActionStateRunning')}</Chip>;
  if (view.state === 'executed') return <Chip tone="done">{t('agentActionStateExecuted')}</Chip>;
  if (view.state === 'failed') return <Chip>{view.changed ? t('agentActionStateChanged') : t('agentActionStateFailed')}</Chip>;
  return <Chip>{view.state === 'expired' ? t('agentActionStateExpired') : t('agentActionStateRejected')}</Chip>;
}

function outcomeLine(t: T, view: AgentActionView): string | null {
  if (view.state === 'executed') return view.decidedBy ? t('agentActionByApproved', { name: view.decidedBy }) : null;
  if (view.state === 'rejected') return view.decidedBy ? t('agentActionByRejected', { name: view.decidedBy }) : null;
  if (view.state === 'expired') return t('agentActionExpiredLine');
  if (view.state === 'failed') return view.changed ? t('agentActionChangedLine') : t('agentActionFailedLine');
  return null;
}
