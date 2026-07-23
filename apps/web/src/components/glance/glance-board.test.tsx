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
  // codex-silent-defect-sweep D-7 — 전부 성공(fetch 실패 아님)이라 partialErrors는 전부 false.
  partialErrors: { overview: false, members: false, stories: false, activity: false, attention: false },
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

// codex-silent-defect-sweep B-3/D-7 — epics fetch 실패(필수 소스)를 조용히 옛 상태 유지로
// 처리하면, 프로젝트를 전환했을 때 직전 프로젝트의 로드맵·hero·멤버가 새 프로젝트 화면에
// 계속 보인다("데이터가 없다"와 "못 가져왔다"가 구분이 안 됨). 이 섹션은 그 회귀를 고정한다.
describe('GlanceBoard — 실패 상태 구분(codex-silent-defect-sweep B-3/D-7)', () => {
  it('epics fetch 실패 시 재시도 가능한 로드 실패 표시를 그린다(정직 빈상태 roadmapEmpty와 다른 문구)', async () => {
    loadGlanceDataMock.mockRejectedValue(new Error('glance: epics fetch failed'));
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('현황판을 불러오지 못했습니다');
    expect(html).not.toContain('아직 시작한 여정이 없어요'); // 정직 빈상태 카피와 섞이지 않음
    expect(html).toContain('다시 시도');
  });

  it('프로젝트 전환 후 epics fetch가 실패하면 직전 프로젝트의 로드맵·타이틀이 남지 않는다(B-3 핵심 회귀)', async () => {
    loadGlanceDataMock.mockResolvedValueOnce({
      ...EMPTY_DATA,
      roadmap: [{ id: 'e1', title: '이전 프로젝트 에픽', roadmapStatus: 'active' }],
      totalEpicCount: 1,
      activeEpicTitle: '이전 프로젝트 에픽',
    });
    const { GlanceBoard } = await import('./glance-board');
    function Wrapper({ projectId }: { projectId: string }) {
      return wrap(<GlanceBoard projectId={projectId} />);
    }
    await act(async () => {
      root.render(<Wrapper projectId="proj-old" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('이전 프로젝트 에픽');

    // 새 프로젝트로 전환 — 이번엔 epics fetch가 실패한다.
    loadGlanceDataMock.mockRejectedValueOnce(new Error('glance: epics fetch failed'));
    await act(async () => {
      root.render(<Wrapper projectId="proj-new" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    // 고쳐지기 전엔 catch가 아무 것도 초기화하지 않아 "이전 프로젝트 에픽"이 그대로 남았다.
    expect(container.innerHTML).not.toContain('이전 프로젝트 에픽');
    expect(container.innerHTML).toContain('현황판을 불러오지 못했습니다');
  });

  it('일부 소스만 실패해도(overview 등) roadmap은 그대로 그리고, 재시도 가능한 부분실패 표시를 추가로 보여준다(전면 에러 아님)', async () => {
    loadGlanceDataMock.mockResolvedValue({
      ...EMPTY_DATA,
      roadmap: [{ id: 'e1', title: 'E-CANVAS', roadmapStatus: 'active' }],
      totalEpicCount: 1,
      activeEpicTitle: 'E-CANVAS',
      partialErrors: { overview: true, members: false, stories: false, activity: false, attention: false },
    });
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('E-CANVAS'); // roadmap은 그대로 렌더(전면 에러로 안 바뀜)
    expect(html).toContain('일부 정보를 불러오지 못했습니다');
    const notice = container.querySelector('[role="alert"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('aria-live')).toBe('assertive');
  });

  it('모든 소스가 성공하면 부분실패 표시가 렌더되지 않는다(회귀 0)', async () => {
    loadGlanceDataMock.mockResolvedValue({
      ...EMPTY_DATA,
      roadmap: [{ id: 'e1', title: 'E-CANVAS', roadmapStatus: 'active' }],
      totalEpicCount: 1,
      activeEpicTitle: 'E-CANVAS',
    });
    await mount();
    expect(container.innerHTML).not.toContain('일부 정보를 불러오지 못했습니다');
  });
});
