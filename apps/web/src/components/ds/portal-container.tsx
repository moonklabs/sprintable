'use client';

import { createContext, useContext, type ReactNode } from 'react';

const PortalContainerContext = createContext<HTMLElement | null>(null);

/**
 * UI-3(a9d56577) 팝업이 그려질 자리 — 기본은 `document.body`(화면 바깥, 앱 테마를 따른다). 이 감싸개 안의 Dialog · Panel · Menu · DatePicker는 `container`가 가리키는 요소 «안»에 그려져
 * 그 요소의 테마(`.dark` · `.ds-theme-light`)를 따른다. 견본 화면이 밝음 · 어둠 틀마다 팝업을 그 틀의 테마로 보이게 하려고 쓴다 — 제품 화면은 쓰지 않는다(`null` = 기본).
 */
export function DsPortalContainer({ container, children }: { container: HTMLElement | null; children: ReactNode }) {
  return <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>;
}

/** 팝업 `Portal`의 `container`로 넘길 값. 감싸개가 없거나 아직 요소가 없으면 `null`(= `document.body`). */
export function useDsPortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}
