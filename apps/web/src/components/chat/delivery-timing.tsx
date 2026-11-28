'use client';

import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import type { DeliveryLog, DeliveryMode } from '@/hooks/use-chat-sse';

/**
 * story 5046 (C13) — WHEN a working agent gets a message: the two parts of the screen.
 *
 *  · `DeliveryChoice` — above the input, only while an agent the message would reach is working: «지금 끼어들기» (the default — today's meaning, nothing pressed) · «끝나고 이어서» (the message waits for the agent's
 *    turn to end). A runtime that cannot take a message into a running turn says so in ONE line when «지금» is on, and the message then waits anyway (it goes in after the turn).
 *  · `DeliveryTimingLine` — under the sender's own line: what the server recorded about HOW it went in, per agent (the sender's own message only — the server sends the log to the sender alone). Until the first record
 *    arrives a message sent as «끝나고 이어서» says it is waiting.
 */
export type DeliveryChoiceValue = 'now' | DeliveryMode;

export function DeliveryChoice({ value, onChange, cannotInterject }: { value: DeliveryChoiceValue; onChange: (v: DeliveryChoiceValue) => void; /** names of the working agents whose runtime cannot take a message into a running turn */ cannotInterject: string[] }) {
  const t = useTranslations('chats');
  return (
    <div className="flex min-w-0 flex-col gap-1 px-1 pb-1" data-testid="delivery-choice">
      <div role="group" aria-label={t('deliveryChoiceLabel')} className="flex flex-wrap items-center gap-1.5">
        <Button size="md" variant={value === 'now' ? 'secondary' : 'quiet'} aria-pressed={value === 'now'} onClick={() => onChange('now')}>{t('deliveryChoiceNow')}</Button>
        <Button size="md" variant={value === 'after_turn' ? 'secondary' : 'quiet'} aria-pressed={value === 'after_turn'} onClick={() => onChange('after_turn')}>{t('deliveryChoiceAfter')}</Button>
      </div>
      {value === 'now' && cannotInterject.length > 0 ? (
        <p className="m-0 break-words text-ds-small text-ds-ink-3" data-testid="delivery-choice-note">{t('deliveryChoiceNoInterject', { names: cannotInterject.join(' · ') })}</p>
      ) : null}
    </div>
  );
}

const MAX_NAMES = 3;

export function DeliveryTimingLine({ mode, log, isMine, nameOf }: { mode: DeliveryMode | undefined; log: DeliveryLog | undefined; isMine: boolean; nameOf: (memberId: string) => string | undefined }) {
  const t = useTranslations('chats');
  if (!isMine) return null;
  const entries = log ? Object.entries(log) : [];
  let lines: string[];
  if (entries.length > 0) {
    const shown = entries.slice(0, MAX_NAMES).map(([id, line]) => t(line.via === 'turn' ? 'deliveryTimingTurn' : 'deliveryTimingNext', { name: nameOf(id) ?? t('deliveryTimingUnnamed') }));
    const more = entries.length - shown.length;
    lines = more > 0 ? [...shown, t('deliveryTimingMore', { n: more })] : shown;
  } else if (mode === 'after_turn') {
    lines = [t('deliveryTimingPending')];
  } else {
    return null; // sent the old way and nothing reported: nothing to say
  }
  return (
    <div data-testid="delivery-timing-line" className="mt-1 flex flex-col items-end gap-0.5 text-right text-xs text-muted-foreground break-keep">
      {lines.map((text, i) => (
        <p key={i} className="m-0 flex items-start justify-end gap-1">
          {i === 0 ? <Clock aria-hidden="true" className="mt-1 size-3 shrink-0" /> : null}
          <span>{text}</span>
        </p>
      ))}
    </div>
  );
}

/** story 5046 (C13): is the «지금 끼어들기 / 끝나고 이어서» choice drawn for these working agents the message would reach? Only when there is at least one and EVERY one is run by a host (the server's `host_run`):
 *  a webhook or the channel plugin reads `delivery_mode` nowhere, so «끝나고 이어서» for it would be a promise nothing keeps. A mix, an unknown (an old server sends no `host_run`) or nobody → no choice, the message goes the old way. */
export function choiceDrawnFor(reached: readonly { hostRun?: boolean }[]): boolean {
  return reached.length > 0 && reached.every((a) => a.hostRun === true);
}
