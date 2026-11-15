import type { ReactNode } from 'react';
import { TeamTabs } from '@/components/team/team-tabs';

// story #4885 (UI-2 AC4) — «팀» 탭줄이 에이전트 화면들(에이전트 · 상세 · 실행 기록 · API 키 · 채용)의 맨 위에 선다. 레이아웃이라 탭 사이를 오가도 줄이 다시 그려지지 않는다.
export default function WorkforceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* story 4889 — 줄이 셸 칼럼 왼쪽 끝에 붙어 있었다(판정 캡처: «팀» 줄 x≈316 · 본문 판 x≈312). 일감 줄 띠(WorkTabsFrame)와 같은 안쪽 여백(px-4 pt-3)으로 맞춘다. */}
      <div className="px-4 pt-3" data-testid="team-tabs-band">
        <TeamTabs />
      </div>
      {children}
    </>
  );
}
