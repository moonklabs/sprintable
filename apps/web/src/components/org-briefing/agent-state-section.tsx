'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAgentStates } from '@/hooks/use-agent-states';
import { restSentence, sessionStateLabel, shownState } from '@/components/chat/agent-session-strip';
import { limitHeld, limitLine, limitLooksAgain, limitTime } from '@/lib/agent-session-limit';
import { AGENT_STATE_FIRST_SHOWN, sortAgentStates, stateRank, type AgentStateRow } from '@/lib/agent-state-list';
import { withProjectParam } from '@/lib/with-project-param';

/**
 * story #4833 (결함 ② · design doc «4833-agent-state-on-today-design») — «에이전트 상태» on the Today screen, under «에이전트가 하는 일»: one line per agent that
 * runs on a computer — its name, the state in the DM strip's own words (one table), the computer, and for a limit the line the strip says. LOOKS ONLY:
 * no button on a row (a stop · an instruction · a restart stay where they are — the DM header, the Mac app); the name is a link to the conversation
 * with that agent when the person has one. The order is a pure function (`sortAgentStates`); the server promises none.
 */
interface Shown { row: AgentStateRow; rank: number; word: ReturnType<typeof shownState> | null }

export function toShown(rows: AgentStateRow[]): Shown[] {
  // an agent that is on no computer at all (no session, not bound) is not «running» anywhere — the list is for agents on computers
  const onAComputer = rows.filter((r) => r.state !== null || r.bound_setup_id !== null);
  return sortAgentStates(onAComputer.map((row) => {
    if (row.state === null) return { row, rank: stateRank(null, false, false), word: null };
    const word = shownState(row);
    const limitShown = limitHeld(word, row.limit) || limitLooksAgain(word, row.limit) || (word === 'waiting_input' && !!row.limit?.self_resume);
    return { row, rank: stateRank(word, limitShown, !!row.first_screen?.ask && (word === 'starting' || word === 'working' || word === 'idle')), word };
  }));
}

function Row({ item, now }: { item: Shown; now: number }) {
  const tState = useTranslations('chats.agentSession');
  const tAgents = useTranslations('agents');
  const locale = useLocale();
  const { row, word } = item;
  // the link carries the conversation's own project (the server always sends both); without a project there is no honest link, so no link
  const href = row.conversation_id && row.conversation_project_id ? withProjectParam(`/chats/${row.conversation_id}`, row.conversation_project_id) : null;
  const device = row.device_name ?? row.bound_device_name;
  const state = word === null
    ? (row.bound_device_name ? tAgents('boundNotRunYet', { name: row.bound_device_name }) : '')
    : sessionStateLabel(row, tState);
  const rest = word === null ? null : limitLine(word, row.limit, now);
  const restText = rest ? restSentence(tState, rest.key, rest.at ? limitTime(rest.at, now, locale) : '') : null;
  return (
    <div className="flex items-start gap-3 border-t border-border px-3 py-3 first:border-t-0" data-testid="agent-state-row">
      <div className="min-w-0 flex-1">
        {href ? (
          <Link href={href} className="block truncate text-sm font-medium text-foreground hover:underline">{row.agent_name}</Link>
        ) : (
          <span className="block truncate text-sm font-medium text-foreground">{row.agent_name}</span>
        )}
        {restText ? <p className="mt-0.5 break-keep text-xs text-muted-foreground">{restText}</p> : null}
      </div>
      {/* the right column may shrink and wraps/cuts its words: a long state sentence or a spaceless computer name must not push a narrow column (the v3 Today's 392px) sideways */}
      <div className="flex min-w-0 max-w-40 flex-col items-end text-right" data-testid="agent-state-right">
        <span className="max-w-full break-keep text-sm text-foreground">{state}</span>
        {word !== null && device ? <span className="max-w-full truncate text-xs text-muted-foreground" data-testid="agent-state-device">{device}</span> : null}
      </div>
    </div>
  );
}

/** the list itself (a pure view of the rows — the test mounts it with rows) */
export function AgentStateList({ rows, now }: { rows: AgentStateRow[]; now: number }) {
  const t = useTranslations('orgBriefing');
  const [all, setAll] = useState(false);
  const items = toShown(rows);
  const shown = all ? items : items.slice(0, AGENT_STATE_FIRST_SHOWN);
  const hidden = items.length - AGENT_STATE_FIRST_SHOWN;
  return (
    <section aria-label={t('agentStateSectionTitle')} data-testid="agent-state-section">
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('agentStateSectionTitle')}</h2>
      </div>
      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('agentStateEmpty')}</p>
        </Card>
      ) : (
        <Card>{shown.map((item) => <Row key={item.row.agent_id} item={item} now={now} />)}</Card>
      )}
      {hidden > 0 ? (
        <div className="mt-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? t('agentStateLess') : t('agentStateMore', { count: hidden })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function AgentStateSection() {
  const { rows, loaded, readAt } = useAgentStates();
  if (!loaded) return null; // before the first answer: nothing (no «0명» flash)
  return <AgentStateList rows={rows} now={readAt} />;
}
