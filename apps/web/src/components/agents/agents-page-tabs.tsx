'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BarChart2, Settings2, ShieldCheck, UserPlus } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentPerformancePanel } from '@/components/agents/agent-performance-panel';
import { AgentManagementTab } from '@/components/agents/agent-management-tab';
import { AccessMatrixTab } from '@/components/agents/access-matrix-tab';
import { RecruiterClient } from '@/app/(authenticated)/agents/recruiter/recruiter-client';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

type AgentsTab = 'stats' | 'manage' | 'recruit' | 'access';
const VALID_TABS = new Set<AgentsTab>(['stats', 'manage', 'recruit', 'access']);

function resolveTab(tab: string | null): AgentsTab {
  return tab && VALID_TABS.has(tab as AgentsTab) ? (tab as AgentsTab) : 'stats';
}

/**
 * 에이전트 관리 IA 통일 — 통계/관리/채용/접근권한 4탭 셸.
 * Phase 1(story d63d3f73): 통계·관리·채용. Phase 2(story da4c6b2d): 접근권한 매트릭스
 * — BE bulk endpoint(`GET /api/v2/agents/access-matrix`)가 org 전체를 admin/owner
 * 단일 게이트로 조회하므로 이 탭 자체를 admin/owner에게만 노출(비-admin은 데이터도
 * 못 받아 조회 자체가 무의미).
 * 페이지 타이틀은 탭 전환과 무관하게 고정 — RecruiterClient 임베드 시 자체 TopBarSlot을
 * showTopBar=false 로 꺼서 top-bar-context 싱글턴 레이스를 원천 차단.
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
      const res = await fetch('/api/me');
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
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
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
          <AgentManagementTab />
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
