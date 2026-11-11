// @vitest-environment jsdom
//
// story #4888(UI-5 홈, AC3 §1) — 홈 = 목록 + 상세 열(B 뼈대). 넓은 화면(≥1024)은 목록 옆에 상세 열, 좁은 화면은 행을 누르면 아래에서 오르는 시트.
// 첫 «손 필요» 행이 처음 선택돼 있고, 선택한 행이 목록에서 사라지면 다음 행이 선택된다(결재 3동작 → 1). j/k · ↑↓로 목록 안을 걷는다(새 명령 키 없음).
// 새 기능 0 · 상세의 모든 글은 행이 이미 가진 사실이다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { TodaySnapshot } from '../org-briefing/derive-today';
import { deriveHome, type HomeModel } from './derive-home';
import type { HomeSources } from './home-model-provider';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const H = koMessages.home;
const NOW = Date.parse('2026-11-11T12:00:00Z');
let container: HTMLDivElement;
let root: Root;

const need = (over: Record<string, unknown>) => ({
  id: 'g1', source: 'gate', state: 'approval', risk: 'low', workItemType: 'story', workItemId: 's1', workItemTitle: '가입 문구 발행', requestedByName: '글쓰기 에이전트',
  reason: '랜딩 문구 세 가지 비교 결과를 올려요', createdAt: '2026-11-11T09:00:00Z', conversationId: 'c1', conversationProjectId: null, recipePublish: false, projectId: null, ...over,
});
function build(items: unknown[], extra: { notifications?: Parameters<typeof deriveHome>[0]['notifications'] } = {}): { model: HomeModel; sources: HomeSources } {
  const snapshot = { needsMe: items, needsMeCount: items.length, agentProgress: [] } as unknown as TodaySnapshot;
  const model = deriveHome({ snapshot, notifications: extra.notifications ?? [], stories: [], completedToday: [], viewerMemberId: null });
  return { model, sources: { snapshot, notificationHrefById: { n1: '/inbox?n=n1' }, runConversationById: {} } };
}
const THREE = () => build([
  need({ id: 'g1', workItemTitle: '가입 문구 발행', createdAt: '2026-11-11T09:00:00Z' }),
  need({ id: 'g2', state: 'signature', risk: 'high', workItemTitle: 'Threads에 글 발행', reason: null, requestedByName: null, createdAt: '2026-11-11T10:00:00Z', conversationId: null }),
  need({ id: 'g3', state: 'answer', source: 'hitl', workItemTitle: '결제 연결 질문', createdAt: '2026-11-11T11:00:00Z' }),
]);

function stubWidth(wide: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: wide, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount(model: HomeModel, sources: HomeSources) {
  const { HomeScreen } = await import('./home-screen');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HomeScreen model={model} sources={sources} /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
}
async function rerender(model: HomeModel, sources: HomeSources) {
  const { HomeScreen } = await import('./home-screen');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HomeScreen model={model} sources={sources} /></NextIntlClientProvider>);
  });
}
const row = (key: string) => container.querySelector(`[data-row-key="${key}"]`) as HTMLElement;
const listRowOf = (key: string) => row(key).querySelector('[data-slot="ds-list-row"]') as HTMLElement;
const detail = () => container.querySelector('[data-testid="home-detail"]') as HTMLElement | null;
const titleButton = (key: string) => row(key).querySelector('button') as HTMLButtonElement;
const press = async (el: Element, key: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }); };

describe('홈 — 넓은 화면: 목록 + 상세 열(story #4888)', () => {
  it('⭐목록 옆에 상세 열이 있고, 첫 «손 필요» 행(가장 오래 기다린 것)이 처음 선택돼 있다', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    expect(container.querySelector('[data-testid="home-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home-detail-column"]')).not.toBeNull();
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
    expect(detail()!.querySelector('h2')!.textContent).toBe('가입 문구 발행');
    expect(listRowOf('gate:g1').getAttribute('aria-current')).toBe('true');
    expect(listRowOf('gate:g2').getAttribute('aria-current')).toBeNull();
  });

  it('⭐다른 행을 누르면(제목 단추 · 줄 어디든) 그 행이 선택되고 상세가 바뀐다', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    await act(async () => { titleButton('gate:g2').click(); });
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g2');
    expect(listRowOf('gate:g2').getAttribute('aria-current')).toBe('true');
    expect(listRowOf('gate:g1').getAttribute('aria-current')).toBeNull();
    // 줄의 빈 자리(부제)를 눌러도 선택된다
    await act(async () => { (listRowOf('hitl:g3').querySelector('.font-mono') as HTMLElement).click(); });
    expect(detail()!.getAttribute('data-row-key')).toBe('hitl:g3');
  });

  it('⭐제목은 키보드로 닿는 진짜 단추다(type=button · ds Button) — 행 안의 행동 링크는 그대로 오른쪽에 있다', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    const b = titleButton('gate:g1');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.getAttribute('data-slot')).toBe('ds-button');
    expect([...row('gate:g1').querySelectorAll('a')].some((a) => a.textContent === H.rowApprove && a.getAttribute('href') === '/gates/g1')).toBe(true);
  });

  it('⭐행 안의 행동 링크(승인)를 눌러도 선택은 바뀌지 않는다 — 링크는 링크가 가는 곳으로만 간다', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
    const link = [...row('gate:g2').querySelectorAll('a')].find((a) => a.textContent === H.rowApproveAndSign) as HTMLAnchorElement;
    link.addEventListener('click', (e) => e.preventDefault());   // jsdom은 이동을 못 한다 — 눌림만 본다
    await act(async () => { link.click(); });
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
    expect(listRowOf('gate:g1').getAttribute('aria-current')).toBe('true');
  });

  it('⭐상세: 요청(사유 · 누가 요청했나) · 대상(무엇을 승인하나) · 같은 행동 링크 · «무엇을 승인하나요?» 한 줄', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    const d = detail()!;
    expect(d.querySelector('[data-testid="home-detail-request"]')!.textContent).toContain('랜딩 문구 세 가지 비교 결과를 올려요');
    expect(d.querySelector('[data-testid="home-detail-request"]')!.textContent).toContain('글쓰기 에이전트님이 요청했어요');
    expect(d.querySelector('[data-testid="home-detail-target"]')!.textContent).toContain('가입 문구 발행');
    const bar = d.querySelector('[data-testid="home-detail-actions"]')!;
    expect(bar.textContent).toContain(H.detailWhat);
    expect(bar.textContent).toContain('가입 문구 발행');
    const link = [...bar.querySelectorAll('a')].find((a) => a.textContent === H.rowApprove)!;
    expect(link.getAttribute('href')).toBe('/gates/g1');           // 목록 행과 같은 주소
    expect([...bar.querySelectorAll('a')].some((a) => a.textContent === koMessages.orgBriefing.conversationOpenLink)).toBe(true);
  });

  it('⭐서명이 필요한(되돌릴 수 없는) 행에만 «되돌리기» 블록이 있다 · 사유가 없으면 «남긴 사유가 없어요»', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    expect(detail()!.querySelector('[data-testid="home-detail-undo"]')).toBeNull();           // g1 = 승인
    await act(async () => { titleButton('gate:g2').click(); });
    const undo = detail()!.querySelector('[data-testid="home-detail-undo"]')!;
    expect(undo.textContent).toContain(koMessages.orgBriefing.signatureRiskNotice);
    expect(detail()!.querySelector('[data-testid="home-detail-request"]')!.textContent).toContain(H.detailNoReason);
    expect(detail()!.querySelector('[data-testid="home-detail-actions"]')!.textContent).toContain(H.rowApproveAndSign);
  });

  it('⭐기다린 시간이 지금 시각 기준으로 나온다(09:00 → 3시간 · 10:00 → 2시간 · 11:00 → 1시간)', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    expect(detail()!.querySelector('[data-testid="home-detail-waited"]')!.textContent).toBe('3시간 기다림');
    await act(async () => { titleButton('gate:g2').click(); });
    expect(detail()!.querySelector('[data-testid="home-detail-waited"]')!.textContent).toBe('2시간 기다림');
    await act(async () => { titleButton('hitl:g3').click(); });
    expect(detail()!.querySelector('[data-testid="home-detail-waited"]')!.textContent).toBe('1시간 기다림');
  });

  it('⭐선택한 행이 목록에서 사라지면(처리됨) 그 자리의 다음 행이 선택된다 · 마지막이면 앞 행 · 다 없으면 «모두 확인했어요»', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    await act(async () => { titleButton('gate:g2').click(); });
    const after = (ids: string[]) => build(ids.map((id) => THREE().sources.snapshot.needsMe.find((i) => i.id === id)));
    // g2(가운데)가 처리돼 사라짐 → 그 자리에 앉은 g3
    let next = after(['g1', 'g3']);
    await rerender(next.model, next.sources);
    expect(detail()!.getAttribute('data-row-key')).toBe('hitl:g3');
    // 마지막 행 g3이 사라짐 → 남은 마지막 g1
    next = after(['g1']);
    await rerender(next.model, next.sources);
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
    // 다 사라짐 → 빈 상세(모두 확인했어요)
    next = after([]);
    await rerender(next.model, next.sources);
    expect(detail()).toBeNull();
    expect(container.querySelector('[data-testid="home-detail-empty"]')!.textContent).toContain(H.emptyAllTitle);
  });

  it('⭐고른 행이 그대로 목록에 있으면(다른 행이 바뀐 읽기) 선택이 옮겨 가지 않는다', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    await act(async () => { titleButton('hitl:g3').click(); });
    const refreshed = build(THREE().sources.snapshot.needsMe.filter((i) => i.id !== 'g1'));   // g1이 사라지고 g3은 그대로
    await rerender(refreshed.model, refreshed.sources);
    expect(detail()!.getAttribute('data-row-key')).toBe('hitl:g3');
  });

  it('⭐j / ↓는 다음 행, k / ↑는 앞 행으로 선택을 옮기고 초점도 따라간다(목록 끝에서는 멈춘다)', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    titleButton('gate:g1').focus();
    await press(titleButton('gate:g1'), 'j');
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g2');
    expect(document.activeElement).toBe(titleButton('gate:g2'));
    await press(titleButton('gate:g2'), 'ArrowDown');
    expect(detail()!.getAttribute('data-row-key')).toBe('hitl:g3');
    await press(titleButton('hitl:g3'), 'j');                 // 끝 — 그대로
    expect(detail()!.getAttribute('data-row-key')).toBe('hitl:g3');
    await press(titleButton('hitl:g3'), 'k');
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g2');
    await press(titleButton('gate:g2'), 'ArrowUp');
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
    await press(titleButton('gate:g1'), 'k');                 // 처음 — 그대로
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
  });

  it('⭐글자 칸에서 치는 j · k는 목록을 걷지 않는다 · Ctrl/Cmd가 같이 눌리면 걷지 않는다(새 명령 키 없음)', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    const input = document.createElement('input');
    row('gate:g1').appendChild(input);
    await press(input, 'j');
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
    await act(async () => { titleButton('gate:g1').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(detail()!.getAttribute('data-row-key')).toBe('gate:g1');
  });

  it('⭐일부만 읽었으면(partial) 손 필요 행이 없어도 상세 열은 «모두 확인했어요»라고 하지 않는다 — 목록과 같은 말을 한다', async () => {
    stubWidth(true);
    const { model, sources } = build([]);
    const { HomeScreen } = await import('./home-screen');
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HomeScreen model={model} sources={sources} partial /></NextIntlClientProvider>);
    });
    const empty = container.querySelector('[data-testid="home-detail-empty"]')!;
    expect(empty.textContent).not.toContain(H.emptyAllTitle);
    expect(empty.querySelector('[data-testid="home-detail-partial"]')!.textContent).toBe(koMessages.orgBriefing.loadErrorTitle);
  });

  it('⭐서버가 센 결재가 행보다 많으면(숨은 N개) 빈 상세 열도 «모두 확인했어요»가 아니라 숨은 수를 말한다', async () => {
    stubWidth(true);
    const { model } = build([]);
    const snapshot = { needsMe: [], needsMeCount: 2, agentProgress: [] } as unknown as TodaySnapshot;
    await mount(model, { snapshot, notificationHrefById: {}, runConversationById: {} });
    const empty = container.querySelector('[data-testid="home-detail-empty"]')!;
    expect(empty.textContent).not.toContain(H.emptyAllTitle);
    expect(empty.querySelector('[data-testid="home-detail-hidden"]')!.textContent).toContain('2');
  });

  it('손 필요 행이 하나도 없으면 상세 열은 «모두 확인했어요»다', async () => {
    stubWidth(true);
    const { model, sources } = build([]);
    await mount(model, sources);
    expect(detail()).toBeNull();
    expect(container.querySelector('[data-testid="home-detail-empty"]')!.textContent).toContain(H.emptyAllTitle);
  });

  it('⭐알림에서 온 «손 필요» 행(멘션)은 종류 · 열기 링크가 있는 상세를 가진다(승인용 블록은 없다)', async () => {
    stubWidth(true);
    const { model, sources } = build([], { notifications: [{ id: 'n1', type: 'conversation.mention', title: '민이 나를 불렀어요', is_read: false, reference_type: null, reference_id: null, created_at: '2026-11-11T11:30:00Z' }] });
    await mount(model, sources);
    const d = detail()!;
    expect(d.getAttribute('data-row-key')).toBe('notification:n1');
    expect(d.querySelector('[data-testid="home-detail-facts"]')!.textContent).toContain(H.kindMention);
    expect(d.querySelector('[data-testid="home-detail-request"]')).toBeNull();
    expect([...d.querySelectorAll('a')].some((a) => a.textContent === H.actionOpen && a.getAttribute('href') === '/inbox?n=n1')).toBe(true);
    expect(d.querySelector('[data-testid="home-detail-waited"]')!.textContent).toBe('30분 기다림');
  });
});

describe('홈 — 좁은 화면: 목록 + 아래에서 오르는 시트(story #4888)', () => {
  it('⭐좁으면 상세 열이 없고 시트도 저절로 열리지 않는다(첫 행이 선택돼 있어도)', async () => {
    stubWidth(false);
    const { model, sources } = THREE();
    await mount(model, sources);
    expect(container.querySelector('[data-testid="home-detail-column"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(listRowOf('gate:g1').getAttribute('aria-current')).toBe('true');   // 선택은 돼 있다(눌러야 시트가 열린다)
  });

  it('⭐행을 누르면 그 행의 상세가 시트로 열린다(이름 있는 대화창 · 같은 상세 내용)', async () => {
    stubWidth(false);
    const { model, sources } = THREE();
    await mount(model, sources);
    await act(async () => { titleButton('gate:g2').click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const sheet = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.getAttribute('aria-label')).toBe('Threads에 글 발행 자세히');
    expect(sheet.querySelector('[data-testid="home-detail"]')!.getAttribute('data-row-key')).toBe('gate:g2');
    expect(sheet.querySelector('[data-testid="home-detail-undo"]')).not.toBeNull();
  });

  it('⭐넓은 화면에서 고른 뒤 창이 좁아져도 시트가 저절로 열리지 않는다(누르지 않았다)', async () => {
    let wide = true; let listener: (() => void) | null = null;
    vi.stubGlobal('matchMedia', (q: string) => ({ get matches() { return wide; }, media: q, addEventListener: (_: string, l: () => void) => { listener = l; }, removeEventListener: () => {} }));
    const { model, sources } = THREE();
    await mount(model, sources);
    await act(async () => { titleButton('hitl:g3').click(); });            // 넓은 화면에서 고름
    wide = false;
    await act(async () => { listener!(); });                                // 창이 좁아짐
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="home-detail-column"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('⭐넓은 화면에서는 시트가 열리지 않는다(같은 상세가 두 군데 그려지지 않는다)', async () => {
    stubWidth(true);
    const { model, sources } = THREE();
    await mount(model, sources);
    await act(async () => { titleButton('gate:g2').click(); });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="home-detail"]')).toHaveLength(1);
  });
});
