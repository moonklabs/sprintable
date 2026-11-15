// @vitest-environment jsdom
//
// story #4888(UI-5 홈, 실물 측정 11-11) — 에이전트의 «결정 요청»이 서버에서 제목 «»으로 와 홈 행이 빈 글자로 떴다(상세 제목 · «대상» 카드 · «무엇을 승인하나요?» 줄도 비고,
// 폰 시트의 이름이 « 자세히»였다 — 보조 기술이 읽을 이름이 없다). 서버가 제목을 채우는 것(today_service)이 본 고침이고, 여기는 «그래도 비어 오면»의 화면 몫:
// 행 · 상세 제목 · 대상 · 시트 이름이 모두 같은 대체 글 «제목이 없는 요청»을 쓴다(셋이 서로 다른 말을 하지 않게 `rowTitle` 하나로).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { TodaySnapshot } from '../org-briefing/derive-today';
import { deriveHome, type HomeModel } from './derive-home';
import type { HomeSources } from './home-model-provider';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-11T12:00:00Z');
let container: HTMLDivElement;
let root: Root;

const need = (over: Record<string, unknown>) => ({
  id: 'g1', source: 'gate', state: 'approval', risk: 'low', workItemType: 'agent_decision', workItemId: 'g1', workItemTitle: '', requestedByName: null,
  reason: null, createdAt: '2026-11-11T09:00:00Z', conversationId: null, conversationProjectId: null, recipePublish: false, projectId: null, ...over,
});
function build(items: unknown[]): { model: HomeModel; sources: HomeSources } {
  const snapshot = { needsMe: items, needsMeCount: items.length, agentProgress: [] } as unknown as TodaySnapshot;
  const model = deriveHome({ snapshot, notifications: [], stories: [], completedToday: [], viewerMemberId: null });
  return { model, sources: { snapshot, notificationHrefById: {}, runConversationById: {} } };
}
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

async function mount(model: HomeModel, sources: HomeSources, locale: 'ko' | 'en' = 'ko') {
  const { HomeScreen } = await import('./home-screen');
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><HomeScreen model={model} sources={sources} /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
}
const FALLBACK = koMessages.home.titleFallback;
const rowButton = () => container.querySelector('[data-testid="home-list"] [data-row-key] button') as HTMLButtonElement;
const detail = () => container.querySelector('[data-testid="home-detail"]') as HTMLElement | null;

describe('홈 — 제목이 빈 결재 요청의 대체 글(story #4888)', () => {
  it('⭐행 · 상세 제목 · «대상» 카드 · «무엇을 승인하나요?» 줄이 모두 «제목이 없는 요청»이다(빈 글자가 아니다)', async () => {
    stubWidth(true);
    const { model, sources } = build([need({})]);
    await mount(model, sources);
    expect(FALLBACK).toBe('제목이 없는 요청');
    expect(rowButton().textContent).toBe(FALLBACK);
    expect(detail()!.querySelector('h2')!.textContent).toBe(FALLBACK);
    expect(detail()!.querySelector('[data-testid="home-detail-target"]')!.textContent).toContain(FALLBACK);
    expect(detail()!.querySelector('[data-testid="home-detail-actions"]')!.textContent).toContain(FALLBACK);
  });

  it('공백뿐인 제목도 «빈 제목»이다', async () => {
    stubWidth(true);
    const { model, sources } = build([need({ workItemTitle: '   ' })]);
    await mount(model, sources);
    expect(rowButton().textContent).toBe(FALLBACK);
    expect(detail()!.querySelector('h2')!.textContent).toBe(FALLBACK);
  });

  it('⭐제목이 있으면 그 제목이다 — 대체 글이 진짜 제목을 가리지 않는다', async () => {
    stubWidth(true);
    const { model, sources } = build([need({ workItemTitle: '랜딩 첫 화면 문구를 «가격 먼저»로 바꿔도 될까요?' })]);
    await mount(model, sources);
    expect(rowButton().textContent).toBe('랜딩 첫 화면 문구를 «가격 먼저»로 바꿔도 될까요?');
    expect(detail()!.querySelector('h2')!.textContent).toBe('랜딩 첫 화면 문구를 «가격 먼저»로 바꿔도 될까요?');
    expect(container.textContent).not.toContain(FALLBACK);
  });

  it('⭐서버가 이제 주는 사유(가정) · 요청자가 «요청» 카드에 선다 — «남긴 사유가 없어요»가 아니다', async () => {
    stubWidth(true);
    const { model, sources } = build([need({ workItemTitle: '가입 확인 단계를 건너뛰어도 될까요?', reason: '이탈이 가장 큰 단계라서요', requestedByName: '개발 에이전트' })]);
    await mount(model, sources);
    const card = detail()!.querySelector('[data-testid="home-detail-request"]')!;
    expect(card.textContent).toContain('이탈이 가장 큰 단계라서요');
    expect(card.textContent).toContain('개발 에이전트');
    expect(card.textContent).not.toContain(koMessages.home.detailNoReason);
  });

  it('⭐폰 시트의 이름이 비지 않는다 — «제목이 없는 요청 자세히» (예전: « 자세히»)', async () => {
    stubWidth(false);
    const { model, sources } = build([need({})]);
    await mount(model, sources);
    await act(async () => { rowButton().click(); });
    await act(async () => { await Promise.resolve(); });
    const sheet = document.body.querySelector('[data-testid="home-detail-sheet"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    const name = sheet.getAttribute('aria-label')!;
    expect(name).toBe(koMessages.home.detailSheetLabel.replace('{title}', FALLBACK));
    expect(name.trim()).toBe(name); // 앞이 비어 있지 않다
    expect(name).toContain(FALLBACK);
  });

  it('en 로케일: «Untitled request»', async () => {
    stubWidth(true);
    const { model, sources } = build([need({})]);
    await mount(model, sources, 'en');
    expect(enMessages.home.titleFallback).toBe('Untitled request');
    expect(rowButton().textContent).toBe('Untitled request');
    expect(detail()!.querySelector('h2')!.textContent).toBe('Untitled request');
  });
});
