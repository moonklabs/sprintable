'use client';

import { useEffect, useRef } from 'react';

// story #1959(P2-S3): 딥링크로 상세 화면에 직접 진입("콜드 진입")했을 때 뒤로가기 1회로
// 소속 탭 루트(parentTab, #1951 매니페스트 SSOT)에 복귀하도록 루트 history entry 를
// 선주입한다.
//
// 콜드 진입 판별 = 이 페이지가 mount 된 시점의 `window.history.length`. 새 탭에서 상세
// URL 을 직접 열면(딥링크·북마크·주소창 입력) 이 페이지가 그 탭의 첫 entry 라 length===1.
// 반대로 앱 내부에서 목록→상세로 이동한 경우엔 그 이동 자체가 이미 router.push 로 entry
// 를 만든 뒤라 length>=2 — 이 훅은 그때 no-op 하므로 AC "SPA 내부 진입=기존 스택 순서
// 유지" 를 별도 분기 없이 만족한다(목록이 이미 진짜 back 대상이 되어 있다).
//
// history.state 에 심는 마커로 멱등 처리 — pushState 로 만든 entry 는 새로고침해도
// 사라지지 않으므로(AC "새로고침에도 target·parentTab 보존") 재마운트 시 중복 합성만
// 막으면 된다.
//
// window.history.back() 은 호출하지 않는다 — Next.js App Router 내부 history 스택과
// 충돌해 이후 router.push() 가 깨지는 회귀가 있었다([[feedback-history-back-nextjs]]).
// 대신 replaceState+pushState 로 raw history API 만 건드리는 chat-view.tsx
// openThread/popstate 패턴과 동형.
const SYNTHESIZED_MARKER = '_sprintableSyntheticRoot';

interface SyntheticHistoryState {
  [SYNTHESIZED_MARKER]?: boolean;
}

export function useSyntheticParentTabHistory(parentTabHref: string) {
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (typeof window === 'undefined') return;

    const state = window.history.state as SyntheticHistoryState | null;
    if (state?.[SYNTHESIZED_MARKER]) return; // 새로고침 후 재마운트 — 이미 합성됨(멱등 가드)
    if (window.history.length > 1) return; // SPA 내부 진입 — 이미 진짜 상위 entry 존재

    const targetUrl = window.location.pathname + window.location.search;
    if (targetUrl === parentTabHref) return; // 이미 탭 루트 자체(합성 불필요)

    window.history.replaceState({ [SYNTHESIZED_MARKER]: true }, '', parentTabHref);
    window.history.pushState({ [SYNTHESIZED_MARKER]: true }, '', targetUrl);
  }, [parentTabHref]);
}
