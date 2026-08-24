import { useEffect, useState, type RefObject } from 'react';
import type { DocHeading } from './doc-heading-utils';

// story #f546601e(v2 5호) — 우측 미니 TOC 현위치 하이라이트(proof-blue) 스크롤 동기.
// rootMargin으로 상단 기준선을 뷰포트 30% 지점까지 내리는 이유 — 순수 교차 여부만
// 쓰면(threshold만) 스크롤을 내리다가 다음 섹션이 화면 맨 아래에 "보이기 시작"하는
// 순간까지 이전 섹션이 계속 활성으로 남는 지연이 생긴다. 기준선을 위로 당겨야 헤딩이
// 뷰포트 상단 부근에 들어오는 순간 바로 전환된다("현재 읽고 있는 절"에 맞음).
const ACTIVE_ROOT_MARGIN = '0px 0px -70% 0px';

export function useActiveDocHeading(
  containerRef: RefObject<HTMLElement | null>,
  headings: DocHeading[],
  rootRef?: RefObject<HTMLElement | null>,
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const idsKey = headings.map((heading) => heading.id).join('|');

  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : [];
    if (!containerRef.current || ids.length === 0) {
      // 여기서 setActiveId(null)을 동기 호출하지 않는다(react-hooks/set-state-in-effect —
      // effect 본문에서의 동기 setState는 캐스케이딩 리렌더 유발). 대신 아래 return
      // 시점에서 idsKey 유무로 파생시킨다 — 헤딩이 없어졌을 때의 결과는 동일하다.
      return;
    }

    // flow-node-story-panel.tsx/flow-map-canvas.tsx 관례 — CSS.escape 기반 셀렉터 문자열
    // 조립 대신 속성값을 직접 비교한다(CSS.escape 전역이 없는 실행환경(jsdom 테스트 등)에도
    // 안 깨진다·헤딩 id는 slugifyHeading 산출이라 CSS 특수문자가 애초에 안 섞임).
    const idSet = new Set(ids);
    const elements = Array.from(containerRef.current.querySelectorAll<HTMLElement>('[id]'))
      .filter((el) => idSet.has(el.id));
    if (!elements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length === 0) return;
        const topmost = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b));
        setActiveId(topmost.target.id);
      },
      { root: rootRef?.current ?? null, rootMargin: ACTIVE_ROOT_MARGIN, threshold: 0 },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [containerRef, rootRef, idsKey]);

  return idsKey ? activeId : null;
}
