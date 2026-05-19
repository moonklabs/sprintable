'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Rocket } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentsDashboard, type AgentDeploymentCard } from '@/components/agents/agents-dashboard';
import { AgentPerformancePanel } from '@/components/agents/agent-performance-panel';

type Tab = 'deployments' | 'performance';

interface AgentsPageTabsProps {
  deployments: AgentDeploymentCard[];
}

export function AgentsPageTabs({ deployments }: AgentsPageTabsProps) {
  const t = useTranslations('agents');
  const [activeTab, setActiveTab] = useState<Tab>('deployments');

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
            <button
              onClick={() => setActiveTab('deployments')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                activeTab === 'deployments'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('tabDeployments')}
            </button>
            <button
              onClick={() => setActiveTab('performance')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                activeTab === 'performance'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('tabPerformance')}
            </button>
          </div>
        }
        actions={
          activeTab === 'deployments' ? (
            <Link href="/agents/deploy" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <Rocket className="mr-1.5 size-3.5" />
              {t('openWizard')}
            </Link>
          ) : null
        }
      />
      {activeTab === 'deployments' ? (
        <AgentsDashboard deployments={deployments} hideTopBar />
      ) : (
        <AgentPerformancePanel />
      )}
    </>
  );
}
