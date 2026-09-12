'use client';

import { useEffect, useState } from 'react';

// story #3815(react-hooks/purity CI 실패, 2026-09-12) — 렌더 본문에서 직접
// `Date.now()`를 부르면 안 된다(불순 호출, React 컴파일러 순수성 규율).
// comments-refresh-button.tsx의 기존 관례(§22-10③ "폴링 금지"의 연장 —
// useState 지연 초기화·useEffect 안에서만 시각을 잰다)와 동형 — 이 훅 하나로
// "이 시각이 지났는가"를 재는 모든 소비처(실패 배지 재시도 버튼·이어서 발행
// 버튼, 페드루 PO CHANGES 2 2026-09-12 17:58Z "같은 게이트 하나")가 수렴한다.
function computeResetPassed(resetAt: string | null | undefined): boolean {
  return !resetAt || Date.now() >= new Date(resetAt).getTime();
}

/** resetAt(ISO 문자열, null/undefined=게이트 없음)이 이미 지났으면 true. resetAt이
 * prop처럼 나중에 바뀌면(재조회로 새 값) 다시 판정하고, 지나지 않았으면 그 시각에
 * 맞춰 setTimeout 하나로 자동 갱신한다(카운트다운 재렌더 0). */
export function useResetPassed(resetAt: string | null | undefined): boolean {
  const [resetPassed, setResetPassed] = useState(() => computeResetPassed(resetAt));
  useEffect(() => {
    setResetPassed(computeResetPassed(resetAt));
  }, [resetAt]);
  useEffect(() => {
    if (resetPassed || !resetAt) return;
    const remainingMs = new Date(resetAt).getTime() - Date.now();
    if (remainingMs <= 0) {
      setResetPassed(true);
      return;
    }
    const timer = setTimeout(() => setResetPassed(true), remainingMs);
    return () => clearTimeout(timer);
  }, [resetAt, resetPassed]);
  return resetPassed;
}
