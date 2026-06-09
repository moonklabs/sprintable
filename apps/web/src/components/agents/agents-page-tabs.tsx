'use client';

import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentPerformancePanel } from '@/components/agents/agent-performance-panel';

// E-SETTINGS S4: Deployments 탭(죽은 managed-deploy surface) 영구 숨김 — Performance 단독.
// 2탭→1탭이라 토글 UI 제거(단일 토글 어색), deploy wizard CTA 미렌더. 라우트 무변경.
// AgentsDashboard 컴포넌트·/agents/deploy route는 보존(reversible).
export function AgentsPageTabs() {
  const t = useTranslations('agents');
  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      <AgentPerformancePanel />
    </>
  );
}
