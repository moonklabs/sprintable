// @vitest-environment jsdom
//
// story #2930(P0-G) I3(doc ia-4zone-redesign-2930, PO 스코프 확定 ①=ⓒ 2026-08-22) — flow+sprints가
// nav에서 「보드」 단일 항목으로 접히며 사라진 sprints 진입점을 이 프레임이 메우는지, 실제로는
// 진짜 라우트 네비게이션인지를 고정한다(story #4291부터 프리패치되는 <Link> · a[href]).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('next/navigation', () => ({
  useParams: () => ({ ws: 'my-ws', proj: 'my-proj' }),
  // [SID:4299] 탭이 첫 화면 뒤 · 누르려는 기색 때 router.prefetch를 부른다.
  useRouter: () => ({ prefetch: () => {}, push: () => {}, replace: () => {} }),
}));

// story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — <lg에서 이 탭행 텍스트·인디케이터가 커진다
// (useIsMobile). jsdom엔 window.matchMedia가 없어 훅 자체를 모킹(flow-client.test.tsx와
// 동일 패턴) — 기존 6개 테스트는 desktop(false) 기본값으로 회귀 0 유지.
let isMobileMock = false;
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileMock,
  MOBILE_BREAKPOINT: 1024,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, messages: typeof koMessages = koMessages) {
  return (
    <NextIntlClientProvider locale="ko" messages={messages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  isMobileMock = false;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('WorkspaceFrameTabs — story #2930 I3', () => {
  it('보드·스프린트·목표·회고·목록·가설 6탭이 렌더한다(story #2931 에픽→#4888 목표·#3845 회고·#3844 목록·#3989 가설 합류)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const tabs = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['목록', '보드', '스프린트', '목표', '회고', '가설']);
  });

  // story #4888 — 이 줄은 링크로 다른 화면(주소)에 가는 줄: nav 랜드마크 + 켜진 링크 aria-current="page". role=tablist / role=tab / aria-selected는 탭 패널을 가진 줄의 말이다.
  it('⭐nav 랜드마크(이름 있음) · 켜진 링크는 aria-current="page" 하나 · role=tab / tablist / aria-selected 0 (되돌리면 RED)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="sprints" />)); });
    const nav = container.querySelector('nav[data-slot="ds-tab-nav"]');
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute('aria-label')).toBe(koMessages.nav.workspace);
    expect([...nav!.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['목록', '보드', '스프린트', '목표', '회고', '가설']);
    const current = [...container.querySelectorAll('[aria-current]')];
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('aria-current')).toBe('page');
    expect(current[0]!.textContent).toBe('스프린트');
    expect(container.querySelector('[role="tab"], [role="tablist"], [aria-selected]')).toBeNull();
  });

  it('active="board"면 보드 탭에 aria-current="page"가 붙는다(나머지는 없다)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const boardTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '보드');
    const sprintsTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '스프린트');
    expect(boardTab?.getAttribute('aria-current')).toBe('page');
    expect(sprintsTab?.getAttribute('aria-current')).toBeNull();
  });

  it('스프린트 탭 링크가 /{ws}/{proj}/sprints로 진짜 라우트 네비게이션한다(in-page 상태 아님)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const sprintsTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '스프린트');
    // story #4291 — 탭은 프리패치되는 <Link>(a[href]) — 예전 router.push 버튼은 프리패치가 없었다.
    expect(sprintsTab!.tagName).toBe('A');
    expect(sprintsTab!.getAttribute('href')).toBe('/my-ws/my-proj/sprints');
  });

  it('보드 탭 링크가 /{ws}/{proj}/flow로 이동한다(nav-config path 불변과 정합)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="sprints" />)); });
    const boardTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '보드');
    // story #4291 — 탭은 프리패치되는 <Link>(a[href]) — 예전 router.push 버튼은 프리패치가 없었다.
    expect(boardTab!.tagName).toBe('A');
    expect(boardTab!.getAttribute('href')).toBe('/my-ws/my-proj/flow');
  });

  it('story #2931 — 목표 탭(경로 epics) 링크가 /{ws}/{proj}/epics로 이동한다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const epicTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '목표');
    // story #4291 — 탭은 프리패치되는 <Link>(a[href]) — 예전 router.push 버튼은 프리패치가 없었다.
    expect(epicTab!.tagName).toBe('A');
    expect(epicTab!.getAttribute('href')).toBe('/my-ws/my-proj/epics');
  });

  it('en 로케일에서도 렌더된다(ko/en 파리티)', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />, enMessages)); });
    const tabs = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['List', 'Board', 'Sprints', 'Goal', 'Retro', 'Hypothesis']);
  });

  it('story #3989 — 가설 탭 링크가 /{ws}/{proj}/hypotheses로 이동하고 active="hypothesis"면 선택 표시된다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const hypothesisTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '가설');
    // story #4291 — 탭은 프리패치되는 <Link>(a[href]) — 예전 router.push 버튼은 프리패치가 없었다.
    expect(hypothesisTab!.tagName).toBe('A');
    expect(hypothesisTab!.getAttribute('href')).toBe('/my-ws/my-proj/hypotheses');

    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="hypothesis" />)); });
    const selected = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '가설');
    expect(selected?.getAttribute('aria-current')).toBe('page');
  });

  it('story #3845 — 회고 탭 링크가 /{ws}/{proj}/retro로 이동하고 active="retro"면 선택 표시된다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const retroTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '회고');
    // story #4291 — 탭은 프리패치되는 <Link>(a[href]) — 예전 router.push 버튼은 프리패치가 없었다.
    expect(retroTab!.tagName).toBe('A');
    expect(retroTab!.getAttribute('href')).toBe('/my-ws/my-proj/retro');

    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="retro" />)); });
    const activeRetroTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '회고');
    expect(activeRetroTab?.getAttribute('aria-current')).toBe('page');
  });

  it('story #3844 — 목록 탭 링크가 /{ws}/{proj}/work-list로 이동하고 active="workList"면 선택 표시된다', async () => {
    const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
    const listTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '목록');
    // story #4291 — 탭은 프리패치되는 <Link>(a[href]) — 예전 router.push 버튼은 프리패치가 없었다.
    expect(listTab!.tagName).toBe('A');
    expect(listTab!.getAttribute('href')).toBe('/my-ws/my-proj/work-list');

    await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="workList" />)); });
    const activeListTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '목록');
    expect(activeListTab?.getAttribute('aria-current')).toBe('page');
  });

  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — "「지금」 탭을 열 때 여기가 보드인 것이
  // 즉시 읽히게" 시각 위계 승격. PR#3358 규율(상위=underline·내부=pill)은 유지하고 그 안에서
  // <lg만 텍스트·인디케이터를 키운다.
  describe('<lg 시각 위계 승격 → ds TabNav(story #4888)', () => {
    // story #4222 — 크기 분기는 JS(useIsMobile)가 아니라 CSS 중단점: 모바일 기본(text-base·pb-2.5·border-b-[3px]) + lg:(1024) 덮어쓰기.
    // 서버·첫 렌더와 하이드레이션 뒤 클래스가 같아 390에서 탭 높이가 30→37px로 바뀌던 흔들림 0.
    // story #4888 — 탭 한 칸의 모양은 ds TabNav가 쥔다(정의 하나): 폰은 누름 영역 44(min-h-11) · 밑줄 3px, 그 밖은 32 · 2px. 크기 분기는 CSS(touch:)라
    // 서버·첫 렌더와 하이드레이션 뒤 클래스가 같다(story #4222 — 390에서 30→37px 흔들림 0).
    it('폰 누름 영역 44 · 밑줄 3px는 CSS(touch:)로 — 뷰포트 판정과 무관하게 같은 클래스(서버 = 최종)', async () => {
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      const seen: string[] = [];
      for (const mobile of [true, false]) {
        isMobileMock = mobile;
        await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
        const cls = ([...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '보드')?.className ?? '');
        for (const c of ['touch:min-h-ds-touch', 'touch:border-b-3', 'min-h-ds-compact']) expect(cls.split(/\s+/), `${mobile} ${c}`).toContain(c);
        seen.push(cls);
      }
      expect(seen[0]).toBe(seen[1]);
    });

    it('모바일에서도 라우팅·aria-selected 동작은 회귀 없다', async () => {
      isMobileMock = true;
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="sprints" />)); });
      const boardTab = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')].find((t) => t.textContent === '보드');
      expect(boardTab?.getAttribute('aria-current')).toBeNull();
      expect(boardTab!.getAttribute('href')).toBe('/my-ws/my-proj/flow');
    });
  });

  // story #4277(유나 판단 ① 필수) — 줄이 가로 스크롤이라 켜진 탭이 화면 밖일 수 있다 → 켜진 탭을 줄 안으로. story #4888 — 이 일은 이제 ds TabNav가 쥔다(UI-3 wave 2b: 줄의 scrollLeft만 맞추고
  // 페이지 스크롤(scrollIntoView)은 안 건드린다; 상세 규칙은 tab-nav.test.tsx). 여기서는 «일감 탭줄이 그 약속을 실제로 받는다»만 못박는다.
  it('⭐켜진 탭(가설)이 줄 오른쪽 밖이면 줄의 scrollLeft만 당긴다 · 이미 보이는 탭이 켜지면 안 움직인다 · scrollIntoView 안 부른다', async () => {
    const spy = vi.fn();
    const origSIV = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy as unknown as typeof origSIV;
    const rect = (l: number, r: number) => ({ left: l, right: r, top: 0, bottom: 32, width: r - l, height: 32, x: l, y: 0, toJSON: () => ({}) }) as DOMRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('data-slot') === 'ds-tab-nav') return rect(0, 300); // 줄: 폭 300
      if (this.getAttribute('data-slot') === 'ds-tab-nav-link') return this.textContent === '가설' ? rect(500, 560) : rect(10, 50); // 가설만 줄 밖
      return rect(0, 0);
    });
    try {
      const { WorkspaceFrameTabs } = await import('./workspace-frame-tabs');
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
      const nav = container.querySelector<HTMLElement>('nav[data-slot="ds-tab-nav"]')!;
      expect(nav.scrollLeft).toBe(0); // 보드는 이미 보인다
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="hypothesis" />)); });
      expect(nav.scrollLeft).toBe(560 - (300 - 24)); // 오른쪽 흐림(24px) 안쪽까지 당김
      expect(spy).not.toHaveBeenCalled();
      const before = nav.scrollLeft;
      await act(async () => { root.render(wrap(<WorkspaceFrameTabs active="board" />)); });
      expect(nav.scrollLeft).toBe(before); // 이미 보이는 탭이 켜져도 안 움직인다
    } finally {
      rectSpy.mockRestore();
      Element.prototype.scrollIntoView = origSIV;
    }
  });
});

