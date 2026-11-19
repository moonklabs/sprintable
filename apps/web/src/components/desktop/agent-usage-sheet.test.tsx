// @vitest-environment jsdom
//
// story 4981 (PR 4) — the computer card's «사용량» sheet: a bar per limit window (whole percent · «N시간 뒤 풀려요» · the strip's «마지막으로 본 지 N분 전»), a CLI with no numbers says why in one closed
// line, a silent computer keeps its last numbers with one line that it is disconnected, every refusal has its sentence in ko AND en, and a closed sheet reads nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { UsageDeps } from '@/lib/agent-usage';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));
const { AgentUsageSheet } = await import('./agent-usage-sheet');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-19T06:00:00Z');
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const win = (over: Record<string, unknown> = {}) => ({ kind: 'five_hour', minutes: 300, used_percent: 63, resets_at: iso(2 * 3_600_000 + 10 * 60_000), ...over });
const row = (over: Record<string, unknown> = {}) => ({ runtime: 'claude', account: 'a1b2c3d4e5f6', state: 'windows', why: null, windows: [win()], seen_at: iso(-5 * 60_000), ...over });
const answer = (usage: unknown[], over: Record<string, unknown> = {}) => ({ agent_id: 'a-1', remote_control: true, setup_id: 's-1', device_name: '윤재의 맥북', connected: true, usage, ...over });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function deps(answers: Response[]) {
  const calls: string[] = [];
  const d: UsageDeps = { fetch: async (id) => { calls.push(id); return answers.shift() ?? json(500, {}); }, now: () => NOW };
  return { d, calls };
}
async function render(d: UsageDeps, locale: 'ko' | 'en' = 'ko', open = true) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentUsageSheet agentId="a-1" open={open} onOpenChange={() => {}} deps={d} />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}
const q = (sel: string) => document.body.querySelector(sel);
const qa = (sel: string) => [...document.body.querySelectorAll(sel)];
const text = (sel: string) => q(sel)?.textContent ?? null;

describe('AgentUsageSheet (story 4981 PR 4)', () => {
  it('a bar per window: the name, the whole percent, a meter with its value, «N시간 뒤 풀려요» and the strip\'s «마지막으로 본 지 N분 전»', async () => {
    const { d, calls } = deps([json(200, answer([row({ windows: [win(), win({ kind: 'seven_day', minutes: 10_080, used_percent: 41, resets_at: iso(3 * 24 * 3_600_000) })] })]))]);
    await render(d);
    expect(calls).toEqual(['a-1']);
    expect(text('[data-testid="agent-usage-title"]')).toBe('윤재의 맥북의 계정 사용량');
    expect(text('[data-testid="agent-usage-lead"]')).toBe('마지막으로 알려 준 값이에요');
    const ws = qa('[data-testid="agent-usage-window"]');
    expect(ws).toHaveLength(2);
    expect(ws[0]!.textContent).toContain('5시간'); expect(ws[0]!.textContent).toContain('63%'); expect(ws[0]!.textContent).toContain('2시간 뒤 풀려요');
    expect(ws[1]!.textContent).toContain('일주일'); expect(ws[1]!.textContent).toContain('41%'); expect(ws[1]!.textContent).toContain('3일 뒤 풀려요');
    const bar = ws[0]!.querySelector('[role="meter"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('63'); expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('63%');
    expect(text('[data-testid="agent-usage-seen"]')).toBe('마지막으로 본 지 5분 전');
    expect(q('[data-testid="agent-usage-disconnected"]')).toBeNull();
  });

  it('a CLI with no numbers says why in ONE closed line: an API-key login → «사용량을 알 수 없어요» · not read → its own sentence — and no bar', async () => {
    const { d } = deps([json(200, answer([row({ runtime: 'claude', state: 'unavailable', why: 'api_key', windows: [] }), row({ runtime: 'codex', account: 'cccccccccccc', state: 'unavailable', why: 'not_read', windows: [] })]))]);
    await render(d);
    const why = qa('[data-testid="agent-usage-why"]');
    expect(why.map((w) => [w.getAttribute('data-why'), w.textContent])).toEqual([['api_key', '사용량을 알 수 없어요'], ['not_read', '이 컴퓨터가 아직 사용량을 읽지 않았어요']]);
    expect(qa('[data-testid="agent-usage-bar"]')).toHaveLength(0);
  });

  it('a silent computer keeps its last numbers with their time and ONE line that it is disconnected', async () => {
    const { d } = deps([json(200, answer([row({ seen_at: iso(-3 * 3_600_000) })], { connected: false }))]);
    await render(d);
    expect(text('[data-testid="agent-usage-disconnected"]')).toBe('지금은 이 컴퓨터와 연결이 끊겨 있어요');
    expect(text('[data-testid="agent-usage-percent"]')).toBe('63%');
    expect(text('[data-testid="agent-usage-seen"]')).toBe('마지막으로 본 지 3시간 전');
  });

  it('two accounts of one CLI are told apart by a number; a CLI with one account has no number; a window with no reset time says so', async () => {
    const { d } = deps([json(200, answer([
      row({ account: 'aaaaaaaaaaaa' }), row({ account: 'bbbbbbbbbbbb', windows: [win({ resets_at: null })] }),
      row({ runtime: 'codex', account: 'cccccccccccc', windows: [win({ kind: 'other', minutes: 60, resets_at: iso(30 * 60_000) })] }),
    ]))]);
    await render(d);
    const heads = qa('[data-testid="agent-usage-row"] h3').map((h) => h.textContent);
    expect(heads).toEqual(['Claude · 계정 1', 'Claude · 계정 2', 'Codex']);
    const rs = qa('[data-testid="agent-usage-resets"]').map((r) => r.textContent);
    expect(rs).toEqual(['2시간 뒤 풀려요', '풀리는 때는 몰라요', '30분 뒤 풀려요']);
    expect(qa('[data-testid="agent-usage-window"]')[2]!.textContent).toContain('1시간 한도');
  });

  it('a window whose reset time has PASSED draws no percent and no bar — one line «풀렸어요 · 새 숫자는 다음 세션 때» (a window still running beside it keeps its bar)', async () => {
    const { d } = deps([json(200, answer([row({ seen_at: iso(-3 * 24 * 3_600_000), windows: [win({ used_percent: 91, resets_at: iso(-2 * 24 * 3_600_000) }), win({ kind: 'seven_day', minutes: 10_080, used_percent: 41 })] })]))]);
    await render(d);
    const ws = qa('[data-testid="agent-usage-window"]');
    expect(ws[0]!.getAttribute('data-stale')).toBe('true');
    expect(ws[0]!.textContent).toContain('5시간 한도'); expect(ws[0]!.textContent).toContain('풀렸어요 · 새 숫자는 다음 세션 때');
    expect(ws[0]!.textContent).not.toContain('91'); expect(ws[0]!.querySelector('[role="meter"]')).toBeNull();
    expect(ws[1]!.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('41');
    expect(text('[data-testid="agent-usage-seen"]')).toBe('마지막으로 본 지 3일 전');
  });

  it('the same calculation while the sheet is OPEN: a window that is freed on the screen turns into «풀렸어요» at its reset time (no re-read)', async () => {
    vi.useFakeTimers();
    try {
      let nowMs = NOW;
      const calls: string[] = [];
      const d: UsageDeps = { fetch: async (id) => { calls.push(id); return json(200, answer([row({ windows: [win({ used_percent: 63, resets_at: iso(10 * 60_000) })] })])); }, now: () => nowMs };
      await render(d);
      expect(text('[data-testid="agent-usage-percent"]')).toBe('63%'); expect(text('[data-testid="agent-usage-resets"]')).toBe('10분 뒤 풀려요');
      nowMs = NOW + 10 * 60_000 + 1000;
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000); });
      expect(q('[data-testid="agent-usage-percent"]')).toBeNull(); expect(q('[data-testid="agent-usage-bar"]')).toBeNull();
      expect(text('[data-testid="agent-usage-stale"]')).toBe('풀렸어요 · 새 숫자는 다음 세션 때');
      expect(calls).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('the states with no rows: remote control off · no computer · nothing reported yet — each its own sentence, no stale rows drawn', async () => {
    await render(deps([json(200, answer([], { remote_control: false, setup_id: null }))]).d);
    expect(text('[data-testid="agent-usage-remote-off"]')).toBe('원격 제어가 꺼져 있어 사용량을 볼 수 없어요');
    await render(deps([json(200, answer([], { setup_id: null, device_name: null }))]).d);
    expect(text('[data-testid="agent-usage-no-computer"]')).toBe('이 에이전트가 쓰는 컴퓨터가 아직 없어요');
    expect(text('[data-testid="agent-usage-title"]')).toBe('이 컴퓨터의 계정 사용량');
    await render(deps([json(200, answer([]))]).d);
    expect(text('[data-testid="agent-usage-empty"]')).toBe('아직 알려 준 값이 없어요 — 에이전트가 일하기 시작하면 보여요');
  });

  it('a read that fails (500 · 404 · 403 · not the view) says so and offers [다시 읽기], which reads again', async () => {
    for (const bad of [json(500, {}), json(404, {}), json(403, {}), json(200, { nope: 1 })]) {
      const { d, calls } = deps([bad, json(200, answer([row()]))]);
      await render(d);
      expect(text('[data-testid="agent-usage-failed"]')).toBe('사용량을 불러오지 못했어요');
      await act(async () => { (q('[data-testid="agent-usage-reload"]') as HTMLButtonElement).click(); });
      for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
      expect(calls).toHaveLength(2); expect(q('[data-testid="agent-usage-failed"]')).toBeNull(); expect(text('[data-testid="agent-usage-percent"]')).toBe('63%');
    }
  });

  it('a seen time further than a minute in the FUTURE says nothing (the strip\'s rule) — the numbers are still drawn', async () => {
    const { d } = deps([json(200, answer([row({ seen_at: iso(10 * 60_000) })]))]);
    await render(d);
    expect(q('[data-testid="agent-usage-seen"]')).toBeNull(); expect(text('[data-testid="agent-usage-percent"]')).toBe('63%');
  });

  it('a far reset (further than a timer can wait) is NOT shown as passed when the timer\'s ceiling is reached; and closing the sheet clears the reset timer', async () => {
    vi.useFakeTimers();
    try {
      const long = new Map<unknown, number>(); const cleared = new Set<unknown>();      // the reset timers (days long) — the dialog\'s own timers are short
      const realSet = globalThis.setTimeout; const realClear = globalThis.clearTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => { const id = realSet(fn, ms, ...rest); if ((ms ?? 0) > 1e8) long.set(id, ms ?? 0); return id; }) as typeof setTimeout);
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id?: Parameters<typeof clearTimeout>[0]) => { cleared.add(id); return realClear(id); }) as typeof clearTimeout);
      let nowMs = NOW;
      const d: UsageDeps = { fetch: async () => json(200, answer([row({ windows: [win({ used_percent: 63, resets_at: iso(40 * 24 * 3_600_000) })] })])), now: () => nowMs };
      const mount = async (open: boolean) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentUsageSheet agentId="a-1" open={open} onOpenChange={() => {}} deps={d} /></NextIntlClientProvider>); }); for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
      await mount(true);
      expect([...long.values()], 'a reset 40 days away is waited for in one timer cut at the ceiling').toEqual([2 ** 31 - 1]);
      nowMs = NOW + 2 ** 31;                                                                   // the ceiling of one timer (≈ 24.8 days) has passed — the reset is still 15 days away
      await act(async () => { await vi.advanceTimersByTimeAsync(2 ** 31); });
      expect(q('[data-testid="agent-usage-stale"]')).toBeNull(); expect(text('[data-testid="agent-usage-percent"]')).toBe('63%');
      expect(long.size, 'the next wait was set from the real time').toBe(2);
      await mount(false);
      expect([...long.keys()].every((id) => cleared.has(id)), 'every reset timer is cleared once the sheet is closed').toBe(true);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('a closed sheet reads NOTHING; opening reads once', async () => {
    const { d, calls } = deps([json(200, answer([row()]))]);
    await render(d, 'ko', false);
    expect(calls).toEqual([]); expect(q('[data-testid="agent-usage-sheet"]')).toBeNull();
    await render(d, 'ko', true);
    expect(calls).toHaveLength(1);
  });

  it('English: every word of the sheet exists in en (percent · windows · resets · seen · why · states)', async () => {
    const { d } = deps([json(200, answer([row({ windows: [win(), win({ kind: 'seven_day', minutes: 10_080, used_percent: 41, resets_at: iso(3 * 24 * 3_600_000) })] }), row({ runtime: 'codex', account: 'cccccccccccc', state: 'unavailable', why: 'api_key', windows: [] })], { connected: false, device_name: 'Yoonjae MacBook' }))]);
    await render(d, 'en');
    const all = document.body.textContent ?? '';
    for (const w of ['Account usage on Yoonjae MacBook', '5-hour limit', 'Weekly limit', '63%', '41%', 'Resets in 2 h', 'Resets in 3 d', 'Last seen 5 min ago', 'Usage is not available', 'This computer is disconnected right now', 'Read again', 'Close']) expect(all, w).toContain(w);
    expect(q('[data-testid="agent-usage-sheet"]')!.textContent).not.toMatch(/[가-힣]/);
  });

  it('no path · account text · agent id is drawn: only the CLI name, the number of the account, names of windows and words', async () => {
    const { d } = deps([json(200, answer([row({ account: 'aaaaaaaaaaaa' }), row({ account: 'bbbbbbbbbbbb' })]))]);
    await render(d);
    const all = document.body.textContent ?? '';
    for (const leaked of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'a-1', 's-1', '/Users']) expect(all).not.toContain(leaked);
  });
});
