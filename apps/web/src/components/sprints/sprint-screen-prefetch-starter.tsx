'use client';

import { useEffect } from 'react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { prefetchSprintScreen } from './sprint-screen-prefetch';

/**
 * story #4328 — `sprints/loading.tsx`에 얹는다. 로딩 경계는 누른 즉시 그려지므로 이 순간 「하루 체크인」 요청을 먼저 출발시킨다(4276 결재
 * 선출발과 같은 문법). 셸의 현재 프로젝트로 출발 — 도착 경로의 프로젝트와 다르면 주소가 달라 넘겨받지 않고 화면이 새로 요청한다(안전).
 */
export function SprintScreenPrefetchStarter() {
  const { currentTeamMemberId, projectId } = useDashboardContext();
  useEffect(() => {
    prefetchSprintScreen({ memberId: currentTeamMemberId, projectId });
  }, [currentTeamMemberId, projectId]);
  return null;
}
