'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

/**
 * story #4631 C · D (Yuna «4631» `4631-breaker-band-copy.md`) — a conversation whose agent messages are paused (the flood block).
 * Under the conversation's head while one is open: what happened · since when · how it is released (the server's release_mode —
 * an auto org's quiet minutes are the server's value) · for a human org owner/admin [멈춤 풀기] with an in-line confirmation and a
 * required one-line reason. After asking: the result line in its place (role=status · focus moves there).
 * The words «폭주 · 차단 · 서킷» are not used (Yuna §0): «에이전트 메시지를 멈췄어요» / [멈춤 풀기].
 */
export interface AgentsPausedState {
  opened_at: string;
  release_mode: string;
  can_release: boolean;
  auto_release_after_minutes?: number | null;
}

const REASON_MAX = 200;

type Phase = 'band' | 'confirming' | 'asking';
type Result = 'resumed' | 'alreadyResumed' | 'forbidden' | 'failed';

export function AgentsPausedBand({ conversationId, state, onResumed }: {
  conversationId: string;
  state: AgentsPausedState | null;
  /** the block is gone (resumed now or already) — the page reads the conversation again */
  onResumed: () => void;
}) {
  const t = useTranslations('chats.agentsPaused');
  const format = useFormatter();
  const tz = useViewerTimeZone() ?? 'UTC';
  const [phase, setPhase] = useState<Phase>('band');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'cancel' | 'result' | 'resume' | null>(null);

  useEffect(() => {
    const next = focusAfter.current;
    if (next === null) return;
    focusAfter.current = null;
    (next === 'cancel' ? cancelRef : next === 'result' ? resultRef : resumeRef).current?.focus();
  }, [phase, result]);

  // a resumed (or already resumed) result stays alone in the band's place; a failure stays under the band and its confirmation
  const gone = result === 'resumed' || result === 'alreadyResumed';
  if (!state && !gone) return null;

  // each result's words by a literal t() call (the i18n key guards read call sites, not a key held in a variable)
  const resultText = result === 'resumed' ? t('resumed') : result === 'alreadyResumed' ? t('alreadyResumed')
    : result === 'forbidden' ? t('forbidden') : result === 'failed' ? t('failed') : null;
  const resultLine = resultText ? (
    <p ref={resultRef} tabIndex={-1} role="status" className="px-4 py-2 text-sm text-foreground outline-none" data-testid="agents-paused-result">
      {resultText}
    </p>
  ) : null;
  if (gone || !state) return resultLine;

  const opened = new Date(state.opened_at);
  const auto = state.release_mode === 'auto' && typeof state.auto_release_after_minutes === 'number';
  // Yuna §6: owner/admin × manual (only a person releases it, and it stays until then) — the warning tint; anyone else neutral
  const tinted = state.can_release && !auto;
  const tone = tinted ? 'border-warning-border bg-warning-tint' : 'border-border bg-muted';
  const trimmed = reason.trim();
  const tooLong = trimmed.length > REASON_MAX;

  const ask = async () => {
    setPhase('asking');
    try {
      const res = await fetchWithAuth(`/api/conversations/${conversationId}/circuit-breaker/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: trimmed }),
      });
      if (res.status === 403) { setResult('forbidden'); setPhase('confirming'); }
      else if (!res.ok) { setResult('failed'); setPhase('confirming'); }
      else {
        const body = (await res.json()) as { released?: boolean };
        setResult(body.released === true ? 'resumed' : 'alreadyResumed');
        setPhase('band');
        onResumed();
      }
    } catch {
      setResult('failed');
      setPhase('confirming');
    }
    focusAfter.current = 'result';
  };

  return (
    <section className={`sticky top-0 z-10 border-b ${tone} break-keep`} data-testid="agents-paused-band" aria-labelledby="agents-paused-title">
      <div className="flex flex-col gap-1 px-4 py-3">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
          <Pause className="size-3.5 shrink-0 self-center" aria-hidden />
          <span id="agents-paused-title" className="font-semibold">{t('title')}</span>
          {/* muted beside the title (Yuna §1) — but never muted on the warning tint (§6) */}
          <span className={`text-xs ${tinted ? 'text-foreground' : 'text-muted-foreground'}`} data-testid="agents-paused-since" title={format.dateTime(opened, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz })}>
            {t('since', { time: format.relativeTime(opened, new Date()) })}
          </span>
        </p>
        <p className="text-sm text-foreground">{t('why')}</p>
        <p className="text-sm text-foreground" data-testid="agents-paused-release">
          {auto ? t('auto', { n: state.auto_release_after_minutes as number }) : state.can_release ? t('untilAdmin') : t('askAdmin')}
        </p>
        {state.can_release && phase === 'band' ? (
          <div>
            <Button ref={resumeRef} size="sm" variant="outline" className="whitespace-nowrap"
              onClick={() => { setResult(null); setPhase('confirming'); focusAfter.current = 'cancel'; }}>
              {t('resume')}
            </Button>
          </div>
        ) : null}
        {state.can_release && phase !== 'band' ? (
          <div role="group" aria-labelledby="agents-paused-confirm" className="flex flex-col gap-2 pt-1">
            <p id="agents-paused-confirm" className="text-sm text-foreground">{t('confirm')}</p>
            <label className="flex flex-col gap-1 text-sm text-foreground">
              {t('reasonLabel')}
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPlaceholder')}
                aria-describedby="agents-paused-reason-note" aria-invalid={tooLong || undefined}
                className="rounded border border-border bg-background px-2 py-1 text-base lg:text-sm" />
            </label>
            {/* the reason a disabled button is disabled, as visible text (not a title) */}
            <p id="agents-paused-reason-note" className="text-xs text-foreground">
              {tooLong ? t('reasonTooLong') : !trimmed ? t('reasonRequired') : null}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button ref={cancelRef} size="sm" variant="outline" disabled={phase === 'asking'}
                onClick={() => { setPhase('band'); setResult(null); focusAfter.current = 'resume'; }}>
                {t('cancel')}
              </Button>
              <Button size="sm" disabled={phase === 'asking' || !trimmed || tooLong} onClick={() => void ask()}>
                {t('confirmResume')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {resultLine}
    </section>
  );
}
