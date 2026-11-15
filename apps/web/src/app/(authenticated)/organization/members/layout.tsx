import type { ReactNode } from 'react';
import { TeamTabs } from '@/components/team/team-tabs';

// story #4885 (UI-2 AC4) — 구성원 화면도 «팀» 탭줄 안에 선다(에이전트 화면들과 같은 줄 · 라우트는 그대로).
export default function MembersLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <TeamTabs />
      {children}
    </>
  );
}
