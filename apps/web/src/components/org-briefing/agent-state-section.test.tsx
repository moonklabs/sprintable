// @vitest-environment jsdom
/**
 * story #4833 (결함 ② · design doc «4833-agent-state-on-today-design») — «에이전트 상태» on the Today screen.
 * The order is held here (not by the server); the words are the DM strip's own table; no row carries a button; empty and «더 보기» as designed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { AgentStateRow } from '@/lib/agent-state-list';

const hook = vi.hoisted(() => ({ value: { rows: [] as AgentStateRow[], loaded: true, readAt: Date.parse('2026-10-30T03:00:00Z') } }));
vi.mock('@/hooks/use-agent-states', () => ({ useAgentStates: () => hook.value }));

import { AgentStateList, AgentStateSection, toShown } from './agent-state-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-30T03:00:00Z');
const ko = koMessages.chats.agentSession as unknown as { state: Record<string, string>; line: Record<string, string> };
const en = enMessages.chats.agentSession as unknown as { state: Record<string, string> };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function row(over: Partial<AgentStateRow> & { agent_name: string }): AgentStateRow {
  return {
    agent_id: `id-${over.agent_name}`, conversation_id: null, conversation_project_id: null, bound_setup_id: 's1', bound_device_name: 'mac-1',
    setup_id: 's1', device_name: 'mac-1', state: 'working', activity: 'working', state_at: '2026-10-30T02:00:00Z', limit: null, first_screen: null, ...over,
  };
}

async function mount(rows: AgentStateRow[], locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentStateList rows={rows} now={NOW} />
      </NextIntlClientProvider>,
    );
  });
}
const names = () => Array.from(container.querySelectorAll('[data-testid="agent-state-row"]')).map((r) => r.querySelector('a,span')!.textContent);
const rowOf = (name: string) => Array.from(container.querySelectorAll('[data-testid="agent-state-row"]')).find((r) => r.querySelector('a,span')?.textContent === name)!;

describe('the order (design doc §3 ③)', () => {
  it('limit → error → a person\'s hand → working → waiting for work / starting → lost → ended → never ran', () => {
    const rows = [
      row({ agent_name: 'g-ended', state: 'stopped', activity: 'stopped' }),
      row({ agent_name: 'e-working', state: 'working', activity: 'working' }),
      row({ agent_name: 'h-never', state: null, activity: null, setup_id: null, device_name: null, state_at: null }),
      row({ agent_name: 'a-limit', state: 'idle', activity: 'paused_limit', limit: { at: '2026-10-30T04:00:00Z', again: false } }),
      row({ agent_name: 'f-lost', state: 'working', activity: 'unknown' }),
      row({ agent_name: 'c-hand', state: 'idle', activity: 'waiting_permission' }),
      row({ agent_name: 'd-ask', state: 'working', activity: 'working', first_screen: { ask: 'trust' } }),
      row({ agent_name: 'b-error', state: 'idle', activity: 'error' }),
      row({ agent_name: 'e2-idle', state: 'idle', activity: 'idle' }),
    ];
    expect(toShown(rows).map((s) => s.row.agent_name)).toEqual(['a-limit', 'b-error', 'c-hand', 'd-ask', 'e-working', 'e2-idle', 'f-lost', 'g-ended', 'h-never']);
  });

  it('a held or self-resuming Claude limit ranks with the limits; the same group sorts by the latest change, then by name', () => {
    const rows = [
      row({ agent_name: 'zed', state: 'idle', activity: 'waiting_input', limit: { self_resume: 'maybe', held: 'screen' }, state_at: '2026-10-30T01:00:00Z' }),
      row({ agent_name: 'ann', state: 'idle', activity: 'paused_limit', limit: { at: '2026-10-30T05:00:00Z' }, state_at: '2026-10-30T02:30:00Z' }),
      row({ agent_name: 'bob', state: 'idle', activity: 'paused_limit', limit: { at: '2026-10-30T05:00:00Z' }, state_at: '2026-10-30T02:30:00Z' }),
      row({ agent_name: 'cy', state: 'working', activity: 'working' }),
    ];
    // ann & bob changed last → first (tie → name) · zed (an older limit) next · working last
    expect(toShown(rows).map((s) => s.row.agent_name)).toEqual(['ann', 'bob', 'zed', 'cy']);
  });

  it('an agent that is on no computer at all (no session · not bound) is not listed', () => {
    const rows = [row({ agent_name: 'ghost', state: null, activity: null, bound_setup_id: null, bound_device_name: null, setup_id: null, device_name: null })];
    expect(toShown(rows)).toEqual([]);
  });
});

describe('the words', () => {
  it('each row says the DM strip\'s word for its state, in ko and en — the lost computer says the Mac app\'s «연결 끊김 · 상태 모름»', async () => {
    const rows = [
      row({ agent_name: 'w', activity: 'working' }),
      row({ agent_name: 'u', state: 'working', activity: 'unknown' }),
      row({ agent_name: 'p', state: 'idle', activity: 'waiting_permission' }),
      row({ agent_name: 'e', state: 'idle', activity: 'error' }),
    ];
    await mount(rows);
    expect(rowOf('w').textContent).toContain(ko.state.working);
    expect(rowOf('u').textContent).toContain('연결 끊김 · 상태 모름');
    expect(rowOf('p').textContent).toContain(ko.state.waiting_permission);
    expect(rowOf('e').textContent).toContain(ko.state.error);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount(rows, 'en');
    expect(rowOf('w').textContent).toContain(en.state.working);
    expect(rowOf('u').textContent).toContain('Disconnected · state unknown');
  });

  it('a limit row carries the line the strip says (here: the app looks again) and names the computer', async () => {
    await mount([row({ agent_name: 'lim', state: 'idle', activity: 'waiting_input', limit: { self_resume: 'maybe', looks: true } })]);
    const r = rowOf('lim');
    expect(r.textContent).toContain(ko.state.paused_limit);
    expect(r.textContent).toContain(ko.line.limitLooking);
    expect(r.textContent).toContain('mac-1');
  });

  it('bound to a computer but never ran: says so with that computer\'s name', async () => {
    await mount([row({ agent_name: 'new', state: null, activity: null, setup_id: null, device_name: null, state_at: null, bound_device_name: 'd4814 mac' })]);
    expect(rowOf('new').textContent).toContain('d4814 mac에 연결됨 · 아직 안 돌았어요');
  });
});

describe('looks only', () => {
  it('no row carries a button or a role=button; the name is a link to the conversation when the person has one, text when not', async () => {
    await mount([
      row({ agent_name: 'linked', conversation_id: 'c-1', conversation_project_id: 'p-1' }),
      row({ agent_name: 'plain', conversation_id: null }),
    ]);
    expect(container.querySelectorAll('[data-testid="agent-state-row"] button, [data-testid="agent-state-row"] [role="button"]').length).toBe(0);
    const link = rowOf('linked').querySelector('a')!;
    expect(link.getAttribute('href')).toContain('/chats/c-1');
    expect(link.getAttribute('href')).toContain('p-1');
    expect(rowOf('plain').querySelector('a')).toBeNull();
    expect(container.querySelectorAll('button').length).toBe(0); // up to eight rows: not even the expander
  });
});

describe('a narrow column', () => {
  it('a spaceless, very long computer name is cut inside a column that may shrink — it cannot push the row sideways', async () => {
    const long = 'x'.repeat(120);
    await mount([row({ agent_name: 'wide', device_name: long, bound_device_name: long })]);
    const right = container.querySelector('[data-testid="agent-state-right"]')!;
    expect(right.className).toContain('min-w-0');
    expect(right.className).toContain('max-w-40');
    expect(right.className).not.toContain('shrink-0');
    expect(container.querySelector('[data-testid="agent-state-device"]')!.className).toContain('truncate');
    // the name column keeps its own room too
    expect(rowOf('wide').querySelector('a,span')!.className).toContain('truncate');
  });
});

describe('empty and «더 보기»', () => {
  it('no agent on a computer: one line, no rows', async () => {
    await mount([]);
    expect(container.textContent).toContain('연결된 에이전트가 아직 없어요');
    expect(container.querySelectorAll('[data-testid="agent-state-row"]').length).toBe(0);
  });

  it('more than eight: eight rows and «3명 더 보기» — it opens in place, and is the only button in the section', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => row({ agent_name: `a${String(i).padStart(2, '0')}` }));
    await mount(rows);
    expect(container.querySelectorAll('[data-testid="agent-state-row"]').length).toBe(8);
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toBe('3명 더 보기');
    await act(async () => { buttons[0].click(); });
    expect(container.querySelectorAll('[data-testid="agent-state-row"]').length).toBe(11);
    expect(container.querySelectorAll('[data-testid="agent-state-row"] button').length).toBe(0);
    expect(container.querySelectorAll('button')[0].textContent).toBe('접기');
  });

  it('exactly eight: no «더 보기»', async () => {
    await mount(Array.from({ length: 8 }, (_, i) => row({ agent_name: `b${i}` })));
    expect(container.querySelectorAll('button').length).toBe(0);
  });
});

describe('the section waits for the first answer', () => {
  it('renders nothing before the first read (no «0명» flash), the list after', async () => {
    hook.value = { rows: [], loaded: false, readAt: 0 };
    const mountSection = async () => act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentStateSection /></NextIntlClientProvider>);
    });
    await mountSection();
    expect(container.textContent).toBe('');
    hook.value = { rows: [row({ agent_name: 'late' })], loaded: true, readAt: NOW };
    await mountSection();
    expect(names()).toEqual(['late']);
  });
});
