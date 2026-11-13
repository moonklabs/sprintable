'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentPerformancePanel } from '@/components/agents/agent-performance-panel';
import { AgentManagementTab } from '@/components/agents/agent-management-tab';
import { AccessMatrixTab } from '@/components/agents/access-matrix-tab';
import { RecruiterClient } from '@/app/(authenticated)/organization/workforce/recruiter/recruiter-client';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { AgentsTopBarTitle } from '@/components/nav/flat-tab-top-bar';
import { RecruitNoProject, recruitNoProjectState } from '@/components/agents/recruit-no-project';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useOrgAdmin } from '@/hooks/use-org-admin';

type AgentsTab = 'stats' | 'manage' | 'recruit' | 'access';
const VALID_TABS = new Set<AgentsTab>(['stats', 'manage', 'recruit', 'access']);

// export — story #2952 AC1 회귀가드(agents-page-tabs.test.tsx)가 전체 컴포넌트 마운트 없이
// 기본 탭 판정만 직접 검증.
export function resolveTab(tab: string | null): AgentsTab {
  return tab && VALID_TABS.has(tab as AgentsTab) ? (tab as AgentsTab) : 'manage';
}

/**
 * 에이전트 화면의 본문 — 통계 · 관리(기본) · 채용 · 접근권한 네 패널 중 **주소의 `?tab=`이 가리키는 하나**를 그린다.
 *
 * story 4889 (UI-6 · W1~W6): 예전엔 이 화면 안에 «통계 · 관리 · 채용 · 접근권한» 탭줄이 한 줄 더 있었다(바깥 «팀» 줄과 «채용»이 두 번 · 두 줄). 그 줄은 «팀» 탭줄(components/team/team-tabs.tsx)로
 * 합쳐졌고(한 줄 · 링크 일곱), 이 화면은 **주소가 유일한 진실**이다 — 탭을 누르면 진짜 이동이라 «안쪽 탭을 눌렀는데 바깥 줄이 안 따라오던»(story #4885 · replaceState 결함) 구조가 사라졌다.
 * 옛 `?tab=manage` · 탭 없는 주소 · 모르는 값은 모두 «관리»(= 팀 줄의 «에이전트»)로 열린다 — 북마크 · 알림 링크 · 문서 속 주소가 깨지지 않게.
 * 비-관리자가 `?tab=access`로 오면 통계로 읽는다(관리자만 쓰는 패널 · 역할 답이 온 뒤에만 — 실제 관리자 사용자의 깜빡임 방지).
 * 페이지 타이틀은 탭 전환과 무관하게 고정 — RecruiterClient 임베드 시 자체 TopBarSlot을 showTopBar=false 로 꺼서 top-bar-context 싱글턴 레이스를 원천 차단.
 *
 * story #2952 AC1(발견성) — 기본 탭은 'manage'(삭제 · 비활성화 · 재활성 액션이 있는 곳 — 통계는 차트뿐이라 첫 방문자가 «삭제 경로가 없다»고 오판한 PO+선생님 실사례).
 */
export function AgentsPageTabs() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const dashboardCtx = useDashboardContext();
  const { projectId, orgId } = dashboardCtx;
  const flatHref = useFlatHref();
  const { isAdmin, loaded } = useOrgAdmin();
  const urlTab = resolveTab(searchParams.get('tab'));
  // 비-관리자가 ?tab=access로 딥링크하면 통계로 폴백 — 역할 확정 前(loaded=false)엔 주소 그대로(실제 관리자의 깜빡임 방지). 렌더 중 파생값(상태로 안 만듦).
  const tab: AgentsTab = loaded && !isAdmin && urlTab === 'access' ? 'stats' : urlTab;
  const goTab = (next: AgentsTab) => router.push(flatHref(`/organization/workforce?tab=${next}`));

  return (
    <>
      <TopBarSlot title={<AgentsTopBarTitle />} showContextChip />
      {/* story 4912 D6 — the statistics are per project: without a project the panel never loads and stayed on «불러오는 중…» for good. Same notice as the Recruit tab (create a project / try again / pick one). */}
      {tab === 'stats' ? (
        !projectId ? (
          <RecruitNoProject state={recruitNoProjectState(dashboardCtx)} createHref={flatHref('/settings?tab=projects')} onRetry={() => window.location.reload()} />
        ) : (
          <AgentPerformancePanel /> /* story 4912 (D): the scope chip «이 프로젝트» is the panel's own PageHead line now */
        )
      ) : null}
      {tab === 'manage' ? <AgentManagementTab onAddAgent={() => goTab('recruit')} /> : null}
      {tab === 'recruit' ? (
        !projectId ? (
          <RecruitNoProject state={recruitNoProjectState(dashboardCtx)} createHref={flatHref('/settings?tab=projects')} onRetry={() => window.location.reload()} />
        ) : (
          <RecruiterClient
            projectId={projectId}
            orgId={orgId}
            showTopBar={false}
            onExit={() => goTab('manage')}
          />
        )
      ) : null}
      {/* 관리자임이 **확인된 뒤에만** 그린다(옛 «접근권한» 탭과 같은 규칙 · story 4891): 역할 답이 오기 전이나 다른 조직의 답일 때 이 패널이 열려 있지 않게 — 그동안은 빈 본문. */}
      {tab === 'access' && isAdmin ? <AccessMatrixTab /> : null}
    </>
  );
}
