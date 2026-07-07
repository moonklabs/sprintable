'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BarChart2, Settings2, UserPlus } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentPerformancePanel } from '@/components/agents/agent-performance-panel';
import { AgentManagementTab } from '@/components/agents/agent-management-tab';
import { RecruiterClient } from '@/app/(authenticated)/agents/recruiter/recruiter-client';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

type AgentsTab = 'stats' | 'manage' | 'recruit';
const VALID_TABS = new Set<AgentsTab>(['stats', 'manage', 'recruit']);

function resolveTab(tab: string | null): AgentsTab {
  return tab && VALID_TABS.has(tab as AgentsTab) ? (tab as AgentsTab) : 'stats';
}

/**
 * 에이전트 관리 IA 통일 Phase 1(story d63d3f73, 유나 핸드오프) — 통계/관리/채용 3탭 셸.
 * 접근권한 매트릭스(4번째 탭)는 Phase 2(BE bulk 선행) 까지 미렌더.
 * 페이지 타이틀은 탭 전환과 무관하게 고정 — RecruiterClient 임베드 시 자체 TopBarSlot을
 * showTopBar=false 로 꺼서 top-bar-context 싱글턴 레이스를 원천 차단.
 */
export function AgentsPageTabs() {
  const t = useTranslations('agents');
  const tRecruiter = useTranslations('recruiter');
  const searchParams = useSearchParams();
  const { projectId, orgId } = useDashboardContext();
  const [activeTab, setActiveTab] = useState<AgentsTab>(() => resolveTab(searchParams.get('tab')));

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as AgentsTab)}>
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
      </Tabs>
    </>
  );
}
