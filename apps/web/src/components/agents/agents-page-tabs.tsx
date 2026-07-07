'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { UserPlus } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentPerformancePanel } from '@/components/agents/agent-performance-panel';
import { Button } from '@/components/ui/button';

// E-SETTINGS S4: Deployments 탭(죽은 managed-deploy surface) 영구 숨김 — Performance 단독.
// 2탭→1탭이라 토글 UI 제거(단일 토글 어색), deploy wizard CTA 미렌더. 라우트 무변경.
// AgentsDashboard 컴포넌트·/agents/deploy route는 보존(reversible).
export function AgentsPageTabs() {
  const t = useTranslations('agents');
  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/agents/recruiter">
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              {t('recruiterCta')}
            </Link>
          </Button>
        }
      />
      <AgentPerformancePanel />
    </>
  );
}
