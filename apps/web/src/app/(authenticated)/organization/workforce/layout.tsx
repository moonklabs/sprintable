import type { ReactNode } from 'react';
import { TeamTabs } from '@/components/team/team-tabs';

// story #4885 (UI-2 AC4) — «팀» 탭줄이 에이전트 화면들(에이전트 · 상세 · 실행 기록 · API 키 · 채용)의 맨 위에 선다. 레이아웃이라 탭 사이를 오가도 줄이 다시 그려지지 않는다.
export default function WorkforceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <TeamTabs />
      {children}
    </>
  );
}
