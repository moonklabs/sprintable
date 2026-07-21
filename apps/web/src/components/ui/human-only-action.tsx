'use client';

import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

interface HumanOnlyActionProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * story #2104(AC6) — 삭제·채택 등 BE가 human-only로 명시 거부하는 파괴적/결정 조작 버튼을
 * 감싸는 wrapper. #2091(게이트 승인)·#2103(HITL 인라인)에서 반복된 결함(BE가 caller.type을
 * 근거로 403을 정확히 판단하는데 FE가 그 판정을 미리 안 보고 버튼을 무조건 열어 "내가 할 수
 * 있다"고 믿게 만든 것)을 재발시키지 않기 위한 공용 게이트다.
 *
 * HOC(함수가 컴포넌트를 받아 새 컴포넌트를 반환)가 아니라 children을 받는 평범한 컴포넌트다 —
 * 오늘 팀이 겪은 HOC lint 차단(클로저를 함수 인자로 넘기는 패턴)과 구조가 다르다.
 *
 * `currentMemberType === 'human'`으로 명시 비교한다 — `if (currentMemberType)`로 쓰면 필드가
 * 없을 때 우연히 닫히는 것(운)이 되고, 지금은 필드 부재 시 닫힌다는 것이 코드에 적혀 있다
 * (fail-closed, #2091/#2103과 동일 원칙).
 */
export function HumanOnlyAction({ children, fallback = null }: HumanOnlyActionProps) {
  const { currentMemberType } = useDashboardContext();
  if (currentMemberType === 'human') return <>{children}</>;
  return <>{fallback}</>;
}
