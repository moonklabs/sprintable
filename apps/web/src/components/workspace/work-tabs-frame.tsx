'use client';

// story #4291(유나 확정 · 4643 다음 단계) — 일감 여섯 탭(목록 · 보드 · 스프린트 · 에픽 · 회고 · 가설)의 탭 줄을 `[ws]/[proj]` 레이아웃으로 올린다.
// 예전엔 각 화면 컴포넌트 안에 있어 전환마다 다시 그려졌고(가로 스크롤 위치 · 켜진 탭 보이기 흔들림), 자리도 둘(inset 16px · sticky 24px)이라
// 탭을 옮길 때 왼쪽 끝이 8px 튀었다. 이제 한 자리: 스크롤 칸 맨 위 sticky 띠(`px-4 pt-3`) · 여섯 탭의 목록 화면에서만(회고 상세 등 더 깊은
// 경로는 띠 없음 — 예전과 같다). 레이아웃은 형제 이동에서 다시 마운트되지 않아 띠가 그대로 남고, 켜진 탭은 누른 즉시 새 조각으로 바뀐다.
//
// 띠 높이는 `--work-tabs-h`로 이 래퍼에 둔다 — 화면 안의 다른 sticky 요소는 `top-[var(--work-tabs-h)]`, 뷰포트 높이 앵커는 그만큼 뺀다.
// 래퍼는 `display: contents`라 레이아웃 흐름은 그대로(자식이 예전처럼 셸 칼럼의 직계로 놓인다) · CSS 변수만 물려준다.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSelectedLayoutSegments } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTopBar } from '@/components/nav/top-bar-context';
import { WORKSPACE_FRAME_TABS, WorkspaceFrameTabs, type WorkspaceFrameTabKey } from './workspace-frame-tabs';

// 서버 렌더에선 useLayoutEffect가 경고를 내므로 브라우저에서만 layout effect.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function WorkTabsFrame({ children }: { children: ReactNode }) {
  const segments = useSelectedLayoutSegments();
  const tab = segments.length === 1 ? WORKSPACE_FRAME_TABS.find((t) => t.path === segments[0]) : undefined;
  const bandRef = useRef<HTMLDivElement | null>(null);
  const [bandHeight, setBandHeight] = useState(0);

  useIsomorphicLayoutEffect(() => {
    const el = bandRef.current;
    if (!tab || !el) { setBandHeight(0); return; }
    setBandHeight(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBandHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab?.key]);

  return (
    <div className="contents" style={{ '--work-tabs-h': `${tab ? bandHeight : 0}px` } as CSSProperties}>
      {tab ? (
        <>
          <div ref={bandRef} className="sticky top-0 z-10 bg-background px-4 pt-3" data-testid="work-tabs-band">
            <WorkspaceFrameTabs active={tab.key} />
          </div>
          <WorkTabTitleFallback tab={tab.key} />
        </>
      ) : null}
      {children}
    </div>
  );
}

// AC3 — 탭을 옮기는 사이(옛 화면 언마운트 → 새 화면 마운트 전 · 로딩 경계) 상단바 제목이 비지 않게, 도착 탭 화면이 쓰는 제목과 **같은 글자 ·
// 같은 모양**을 폴백으로 둔다(화면이 붙으면 화면 슬롯이 이긴다 · top-bar-context). 키는 리터럴로 부른다(i18n 죽은-키 가드가 센다).
function WorkTabTitleFallback({ tab }: { tab: WorkspaceFrameTabKey }) {
  const tFlow = useTranslations('flow');
  const tWorkList = useTranslations('workList');
  const tSprints = useTranslations('sprints');
  const tBoard = useTranslations('board');
  const tRetro = useTranslations('retro');
  const tNav = useTranslations('nav');
  const { setFallback } = useTopBar();
  const title =
    tab === 'board' ? <h1 className="text-sm font-display font-extrabold">{tFlow('title')}</h1>
      : tab === 'workList' ? <h1 className="text-sm font-medium">{tWorkList('title')}</h1>
        : tab === 'sprints' ? <h1 className="text-sm font-medium">{tSprints('title')}</h1>
          : tab === 'epic' ? <h1 className="text-sm font-medium">{tBoard('epicSwimlaneTitle')}</h1>
            : tab === 'retro' ? <h1 className="text-sm font-medium">{tRetro('title')}</h1>
              : <h1 className="text-sm font-medium">{tNav('hypothesis')}</h1>;
  useEffect(() => {
    setFallback({ title, showContextChip: true });
    return () => setFallback(null);
    // title은 tab과 로케일에서만 파생 — 매 렌더 새 엘리먼트라 deps에 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, setFallback]);
  return null;
}
