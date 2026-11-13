// @vitest-environment jsdom
//
// 4909 AC3 (가설 칸 2단계) — the hypothesis row on the ds ListRow grammar, its ⋯ menu and the Mac right-click menu (the SAME entries calling the SAME functions), and the verdict card on the ds tokens.
// Every test goes RED if the thing it names is put back the old way. (The old row tests — the inline «측정 시작», the 4311 owner labels — run unchanged next to these.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';
import { HypothesisRow, type HypothesisRowActions } from './hypothesis-row';
import { HypothesisVerdictCard } from './hypothesis-verdict-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const T = koMessages.hypotheses;

let container: HTMLDivElement;
let root: Root;
const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const hyp = (over: Partial<Hypothesis> = {}): Hypothesis => ({
  id: 'h1', org_id: 'org-1', project_id: 'proj-1', owner_member_id: 'm1', created_by_member_id: null, confirmed_by_member_id: null,
  statement: '랜딩 첫 화면에 후기를 넣으면 가입 전환이 오른다', metric_definition: { metric: 'activation', target: 10, direction: 'up' } as never, measure_after: '2026-12-01T00:00:00Z',
  status: 'active', outcome_result: null, confidence: null, source_type: null, source_id: null, human_accounting: {}, gate_contract: {},
  epic_ids: [], story_ids: [], created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z', ...over,
}) as Hypothesis;
const actionsMock = (): HypothesisRowActions => ({ onConfirmDraft: vi.fn(), onActivate: vi.fn(), onLinkStory: vi.fn(), onKill: vi.fn(), onResolve: vi.fn(), onStartMeasuring: vi.fn() });

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

async function draw(h: Hypothesis, actions = actionsMock(), resolveName?: (id: string) => string) {
  await act(async () => { root.render(wrap(<HypothesisRow hypothesis={h} actions={actions} resolveName={resolveName} />)); });
  return actions;
}
const row = () => container.querySelector('[data-testid="hypothesis-row"]') as HTMLElement;
const menuItems = () => [...document.querySelectorAll('[data-slot="ds-menu-item"]')] as HTMLElement[];
const openDots = async () => { await act(async () => { container.querySelector('[aria-label]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const openRight = async () => { await act(async () => { container.querySelector('[data-slot="ds-list-row"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); }); };
const closeMenus = async () => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await act(async () => { await Promise.resolve(); }); };

describe('HypothesisRow — 4909 ds ListRow 문법', () => {
  it('⭐the row is a ds ListRow: status chip · the statement (two lines at most) · the mono second line · the ⋯ trigger — no old rounded-xl bordered box', async () => {
    await draw(hyp());
    expect(row().querySelector('[data-slot="ds-list-row"]')).toBeTruthy();
    expect(row().querySelector('[data-slot="ds-chip"]')?.getAttribute('data-status')).toBe('active');
    const statement = [...row().querySelectorAll('span')].find((s) => s.textContent === '랜딩 첫 화면에 후기를 넣으면 가입 전환이 오른다')!;
    expect(statement.className).toContain('line-clamp-2');
    expect(row().querySelector('.font-mono')).toBeTruthy();
    expect(row().querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(T.actions);
    expect(row().className).not.toMatch(/rounded-xl|bg-background/);
  });

  it('the second line carries «지표 · 날짜 · 🔗 연결 수 · @담당» — ≤ for a downward metric, the link count only when linked, the owner always', async () => {
    await draw(hyp({ metric_definition: { metric: 'bounce', target: 3.5, direction: 'down' } as never, story_ids: ['s1', 's2'] }), actionsMock(), (id) => (id === 'm1' ? '송윤재' : ''));
    const sub = row().querySelector('.truncate.font-mono')!.textContent!;
    expect(sub).toContain('bounce ≤ 3.50');
    expect(sub).toContain('2026-12-01');
    expect(sub).toContain('🔗 2');
    expect(sub).toContain('@송윤재');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await draw(hyp({ story_ids: [] }));
    expect(row().querySelector('.truncate.font-mono')!.textContent).not.toContain('🔗');
  });

  it('a killed hypothesis keeps its statement struck through and quiet', async () => {
    await draw(hyp({ status: 'killed' }));
    const statement = [...row().querySelectorAll('span')].find((s) => s.className.includes('line-clamp-2'))!;
    expect(statement.className).toContain('line-through');
    expect(statement.className).toContain('text-ds-ink-3');
  });

  it('⭐the ONE inline action of the moment sits on the right: 초안 확인 (an unconfirmed AI draft) · 활성화 (proposed) · 측정 시작 (active, with its hint line) · none for measuring · killed', async () => {
    const inline = () => [...row().querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === null).map((b) => b.textContent?.trim());
    await draw(hyp({ status: 'proposed', draft_metadata: { template: true } as never }));
    expect(inline()).toEqual([T.confirmDraft]);
    expect(row().textContent).toContain(T.draftPin);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await draw(hyp({ status: 'proposed' }));
    expect(inline()).toEqual([T.activate]);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await draw(hyp({ status: 'active' }));
    expect(inline()).toEqual([T.startMeasuring]);
    expect(row().textContent).toContain('2026-12-01에 자동으로 전환돼요'); // the hint line (when measuring starts) stays a line of the row — the date alone is on the second line too, so the sentence is what is asserted
    for (const status of ['measuring', 'killed'] as const) {
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await draw(hyp({ status }));
      expect(inline()).toEqual([]);
    }
  });

  it('the inline action calls the SAME function as before (확인 → onConfirmDraft · 활성화 → onActivate · 측정 시작 → onStartMeasuring)', async () => {
    const cases: Array<[Partial<Hypothesis>, string, keyof HypothesisRowActions]> = [
      [{ status: 'proposed', draft_metadata: { template: true } as never }, T.confirmDraft, 'onConfirmDraft'],
      [{ status: 'proposed' }, T.activate, 'onActivate'],
      [{ status: 'active' }, T.startMeasuring, 'onStartMeasuring'],
    ];
    for (const [over, label, fn] of cases) {
      await act(async () => { root.unmount(); }); root = createRoot(container);
      const h = hyp(over); const actions = await draw(h);
      const b = [...row().querySelectorAll('button')].find((x) => x.textContent?.includes(label))!;
      await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(actions[fn]).toHaveBeenCalledWith(h);
    }
  });
});

describe('HypothesisRow — 4909 ⋯ 메뉴와 맥 우클릭 메뉴는 같은 항목 · 같은 함수', () => {
  const EXPECT: Array<[Hypothesis['status'], string[]]> = [
    ['active', [T.linkStory, T.kill]],
    ['proposed', [T.linkStory, T.kill]],
    ['measuring', [T.linkStory, T.resolveVerify, T.resolveFalsify, T.kill]],
    ['killed', [T.linkStory]],
  ];
  it.each(EXPECT)('⭐%s: the ⋯ menu and the right-click menu list exactly the same entries', async (status, labels) => {
    await draw(hyp({ status }));
    await openDots();
    const viaDots = menuItems().map((m) => m.textContent?.trim());
    expect(viaDots).toEqual(labels);
    await closeMenus();
    document.body.querySelectorAll('[data-slot="ds-menu-item"]').forEach((e) => e.remove());
    await openRight();
    expect(menuItems().map((m) => m.textContent?.trim())).toEqual(viaDots);
  });

  it.each([['⋯', 'dots'], ['right-click', 'right']] as const)('⭐via %s: each entry calls the same function with the hypothesis (연결 · 달성 · 반증 · 검증 중단)', async (_n, how) => {
    const h = hyp({ status: 'measuring' });
    const pairs: Array<[string, (a: HypothesisRowActions) => unknown, unknown[]]> = [
      [T.linkStory, (a) => a.onLinkStory, [h]],
      [T.resolveVerify, (a) => a.onResolve, [h, 'verified']],
      [T.resolveFalsify, (a) => a.onResolve, [h, 'falsified']],
      [T.kill, (a) => a.onKill, [h]],
    ];
    for (const [label, pick, args] of pairs) {
      await act(async () => { root.unmount(); }); root = createRoot(container); document.body.querySelectorAll('[data-slot="ds-menu-item"]').forEach((e) => e.remove());
      const actions = await draw(h);
      if (how === 'dots') await openDots(); else await openRight();
      const item = menuItems().find((m) => m.textContent?.trim() === label)!;
      expect(item).toBeTruthy();
      await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(pick(actions)).toHaveBeenCalledWith(...args);
    }
  });

  it('⭐the WHOLE row is the right-click target — the «측정 시작» hint line too (codex 1차: it once sat outside the trigger, and the helper only right-clicked the list row)', async () => {
    await draw(hyp({ status: 'active' }));
    const hint = container.querySelector('[data-testid="hypothesis-start-hint"]')!;
    expect(hint).toBeTruthy();
    await act(async () => { hint.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
    expect(menuItems().map((m) => m.textContent?.trim())).toEqual([T.linkStory, T.kill]);
    await closeMenus();
    document.body.querySelectorAll('[data-slot="ds-menu-item"]').forEach((e) => e.remove());
    // the action cluster (the buttons' own gutter) is a target as well
    const cluster = container.querySelector('[aria-label]')!.parentElement!;
    await act(async () => { cluster.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })); });
    expect(menuItems().map((m) => m.textContent?.trim())).toEqual([T.linkStory, T.kill]);
  });

  it('the kill entry is the danger one (red only where the word is «검증 중단»)', async () => {
    await draw(hyp({ status: 'measuring' }));
    await openRight();
    expect(menuItems().map((m) => [m.textContent?.trim(), m.getAttribute('data-variant')])).toEqual([
      [T.linkStory, 'default'], [T.resolveVerify, 'default'], [T.resolveFalsify, 'default'], [T.kill, 'danger'],
    ]);
  });

  it('⭐a double-click opens nothing and calls nothing (a hypothesis has no page to open — the transition button is not bound to it)', async () => {
    const actions = await draw(hyp({ status: 'active' }));
    await act(async () => { container.querySelector('[data-slot="ds-list-row"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(menuItems()).toHaveLength(0);
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('HypothesisVerdictCard — 4909 ds 토큰 (the pair keeps its colours; red is never the verdict)', () => {
  const verdict = (status: 'verified' | 'falsified', result: Record<string, unknown> | null) => hyp({ status, outcome_result: result as never });
  const card = () => container.querySelector('[data-testid="hypothesis-verdict"]') as HTMLElement;
  it('⭐verified = the done (green) soft face · falsified = the info (blue) soft face — and neither is the failed (red) one', async () => {
    await act(async () => { root.render(wrap(<HypothesisVerdictCard hypothesis={verdict('verified', { metric: 'a', target: 10, actual: 12, direction: 'up', scored_at: '2026-11-20T00:00:00Z' })} />)); });
    expect(card().className).toContain('bg-ds-done-soft');
    expect(card().innerHTML).toContain('text-ds-done');
    expect(card().innerHTML).not.toMatch(/failed|destructive/);
    await act(async () => { root.render(wrap(<HypothesisVerdictCard hypothesis={verdict('falsified', { metric: 'a', target: 10, actual: 4, direction: 'up', scored_at: '2026-11-20T00:00:00Z' })} />)); });
    expect(card().className).toContain('bg-ds-info-soft');
    expect(card().innerHTML).toContain('text-ds-info');
    expect(card().innerHTML).not.toMatch(/failed|destructive|ds-done/);
    expect(card().className).not.toMatch(/success|info-tint|rounded-2xl/);
  });
  it('the readout is unchanged: the word + mark · target (≥ / ≤) · actual · the score date · the reason · who closed it · the delta track marker in the verdict colour', async () => {
    await act(async () => { root.render(wrap(<HypothesisVerdictCard hypothesis={verdict('verified', { metric: 'a', target: 10, actual: 12.5, direction: 'up', scored_at: '2026-11-20T00:00:00Z', reason: '후기 덕분이에요', closed_by: 'human', closed_by_member_id: 'm1' })} resolveName={() => '송윤재'} />)); });
    const txt = card().textContent!;
    expect(txt).toContain('✓');
    expect(txt).toContain(T.statusVerified);
    expect(txt).toContain('≥ 10');
    expect(txt).toContain('12.50');
    expect(txt).toContain('2026-11-20');
    expect(txt).toContain('후기 덕분이에요');
    expect(txt).toContain('송윤재');
    expect(card().querySelector('.rounded-full')!.className).toContain('bg-ds-done');
  });
});
