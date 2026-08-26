'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BarChart2, Settings2, ShieldCheck, UserPlus } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentPerformancePanel } from '@/components/agents/agent-performance-panel';
import { AgentManagementTab } from '@/components/agents/agent-management-tab';
import { AccessMatrixTab } from '@/components/agents/access-matrix-tab';
import { RecruiterClient } from '@/app/(authenticated)/organization/workforce/recruiter/recruiter-client';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';

type AgentsTab = 'stats' | 'manage' | 'recruit' | 'access';
const VALID_TABS = new Set<AgentsTab>(['stats', 'manage', 'recruit', 'access']);

// export — story #2952 AC1 회귀가드(agents-page-tabs.test.tsx)가 전체 컴포넌트 마운트 없이
// 기본 탭 판정만 직접 검증.
export function resolveTab(tab: string | null): AgentsTab {
  return tab && VALID_TABS.has(tab as AgentsTab) ? (tab as AgentsTab) : 'manage';
}

/**
 * 에이전트 관리 IA 통일 — 통계/관리/채용/접근권한 4탭 셸.
 * Phase 1(story d63d3f73): 통계·관리·채용. Phase 2(story da4c6b2d): 접근권한 매트릭스
 * — BE bulk endpoint(`GET /api/v2/agents/access-matrix`)가 org 전체를 admin/owner
 * 단일 게이트로 조회하므로 이 탭 자체를 admin/owner에게만 노출(비-admin은 데이터도
 * 못 받아 조회 자체가 무의미).
 * 페이지 타이틀은 탭 전환과 무관하게 고정 — RecruiterClient 임베드 시 자체 TopBarSlot을
 * showTopBar=false 로 꺼서 top-bar-context 싱글턴 레이스를 원천 차단.
 *
 * story #2952 AC1(발견성) — 기본 탭을 'stats'→'manage'로 정정. 사이드바 GNB "조직›워크포스"
 * 항목(nav-config.ts)과 settings/page.tsx의 "에이전트 관리로 이동" 버튼이 모두 ?tab= 없이
 * 이 경로로 보내는데, 실제 삭제(비활성화)/재활성 액션은 관리 탭에만 있다 — 첫 방문자가
 * 통계 탭(차트만 있음)에 떨어져 "삭제 경로가 없다"고 오판한 근본 원인(PO+선생님 실사례,
 * customer-zero: 코드상 존재해도 못 찾으면 없는 것과 같다).
 */
export function AgentsPageTabs() {
  const t = useTranslations('agents');
  const tRecruiter = useTranslations('recruiter');
  const searchParams = useSearchParams();
  const { projectId, orgId } = useDashboardContext();
  const [activeTab, setActiveTab] = useState<AgentsTab>(() => resolveTab(searchParams.get('tab')));
  const [isAdmin, setIsAdmin] = useState(false);
  const [meLoaded, setMeLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetchWithAuth('/api/me');
      if (res.ok) {
        const json = await res.json() as { data?: { role?: string } };
        const role = json.data?.role ?? 'member';
        setIsAdmin(role === 'admin' || role === 'owner');
      }
      setMeLoaded(true);
    })();
  }, []);

  // 비-admin이 ?tab=access로 딥링크하면 통계로 폴백 — role 확정 前(meLoaded=false)엔
  // activeTab을 그대로 보여줘 실제 admin 사용자의 깜빡임을 방지한다. effect가 아닌
  // 렌더 중 파생값으로 계산(react-hooks/set-state-in-effect 회피 — 굳이 상태로 안 만듦).
  const effectiveTab = meLoaded && !isAdmin && activeTab === 'access' ? 'stats' : activeTab;

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />
      <Tabs value={effectiveTab} onValueChange={(v) => setActiveTab(v as AgentsTab)}>
        <div className="border-b border-border px-6">
          <TabsList variant="line">
            <TabsTrigger value="stats">
              <BarChart2 className="h-4 w-4" />
              {t('statsTab')}
            </TabsTrigger>
            <TabsTrigger value="manage">
              <Settings2 className="h-4 w-4" />
              {t('manageTab')}
            </TabsTrigger>
            <TabsTrigger value="recruit">
              <UserPlus className="h-4 w-4" />
              {t('recruitTab')}
            </TabsTrigger>
            {isAdmin ? (
              <TabsTrigger value="access">
                <ShieldCheck className="h-4 w-4" />
                {t('accessTab')}
              </TabsTrigger>
            ) : null}
          </TabsList>
        </div>

        <TabsContent value="stats">
          <div className="flex items-center gap-2 border-b border-border px-6 py-2">
            <Badge variant="info">{t('scopeThisProject')}</Badge>
          </div>
          <AgentPerformancePanel />
        </TabsContent>

        <TabsContent value="manage">
          <AgentManagementTab onAddAgent={() => setActiveTab('recruit')} />
        </TabsContent>

        <TabsContent value="recruit">
          {!projectId ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-sm text-muted-foreground">{tRecruiter('noProject')}</p>
            </div>
          ) : (
            <RecruiterClient
              projectId={projectId}
              orgId={orgId}
              showTopBar={false}
              onExit={() => setActiveTab('manage')}
            />
          )}
        </TabsContent>

        {isAdmin ? (
          <TabsContent value="access">
            <AccessMatrixTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
