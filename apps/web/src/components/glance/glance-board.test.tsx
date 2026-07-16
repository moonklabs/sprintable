// @vitest-environment jsdom
//
// story 190f4c71(doc resource-view-firsttouch-identity-pattern §4 "현황판" 행): 빈 로드맵
// first-touch가 밋밋한 "아직 로드맵이 없습니다." 대신 5요소(아이콘+headline+explainer+
// waypoint visual+CTA+AI hint) 정체성 explainer로 렌더되는지, 데이터 있으면 완전 무변화인지
// 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { loadGlanceDataMock } = vi.hoisted(() => ({
  loadGlanceDataMock: vi.fn(),
}));

vi.mock('./load-glance-data', () => ({
  loadGlanceData: (...args: unknown[]) => loadGlanceDataMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function wrapEn(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const EMPTY_DATA = {
  roadmap: [],
  totalEpicCount: 0,
  collaboration: [],
  events: [],
  activeEpicTitle: null,
  heroStory: null,
  memberMap: {},
  attentionSignals: [],
  heroEnvelope: null,
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
});

async function mount() {
  const { GlanceBoard } = await import('./glance-board');
  await act(async () => { root.render(wrap(<GlanceBoard projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function mountEn() {
  const { GlanceBoard } = await import('./glance-board');
  await act(async () => { root.render(wrapEn(<GlanceBoard projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('GlanceBoard — 현황판 first-touch 정체성', () => {
  it('빈 로드맵이 5요소 explainer(headline+설명+waypoint+CTA+AI hint)로 렌더된다 — 구 "아직 로드맵이 없습니다." 소거', async () => {
    loadGlanceDataMock.mockResolvedValue(EMPTY_DATA);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 시작한 여정이 없어요');
    expect(html).toContain('현황판은 프로젝트가 어디서 시작해');
    // 유나 가디언 리뷰(어긋남2) — 2번째 문장 복원: 목표/스프린트 누적이 왜 여정을 그리는지 CTA와 연결.
    // (8fc51517: 에픽→목표 라벨 rename에 맞춰 기대 카피 갱신)
    expect(html).toContain('목표와 스프린트가 쌓이면 프로젝트의 여정이 여기 그려집니다');
    expect(html).toContain('시작');
    expect(html).toContain('지금');
    expect(html).toContain('앞으로');
    expect(html).toContain('첫 목표로 여정 시작하기');
    expect(html).toContain('목표 하나면 여정이 시작돼요');
    expect(html).not.toContain('아직 로드맵이 없습니다.'); // 구 카피 소거
  });

  it('CTA가 /goals로 링크된다(신규 다이얼로그 없음)', async () => {
    loadGlanceDataMock.mockResolvedValue(EMPTY_DATA);
    await mount();
    const link = container.querySelector('a[href="/goals"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('첫 목표로 여정 시작하기');
  });

  it('로드맵 데이터가 있으면 기존 보드(에디토리얼 타이틀)가 그대로 렌더되고 explainer는 미노출된다(회귀 0)', async () => {
    loadGlanceDataMock.mockResolvedValue({
      ...EMPTY_DATA,
      roadmap: [{ id: 'e1', title: 'E-CANVAS', roadmapStatus: 'active' }],
      totalEpicCount: 1,
      activeEpicTitle: 'E-CANVAS',
    });
    await mount();
    const html = container.innerHTML;
    expect(html).not.toContain('아직 시작한 여정이 없어요');
    expect(html).not.toContain('첫 목표로 여정 시작하기');
  });

  it('interpolates boardChapterActive correctly in EN locale, not the raw i18n key (regression: en.json used {goal} while the call site passes epic)', async () => {
    loadGlanceDataMock.mockResolvedValue({
      ...EMPTY_DATA,
      roadmap: [{ id: 'e1', title: 'Checkout Redesign', roadmapStatus: 'active' }],
      totalEpicCount: 1,
      activeEpicTitle: 'Checkout Redesign',
    });
    await mountEn();
    const html = container.innerHTML;
    expect(html).toContain('Checkout Redesign');
    expect(html).not.toContain('boardChapterActive');
    expect(html).not.toMatch(/\{(goal|epic)\}/);
  });
});
