import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { checkFeatureLimit } from '@/lib/check-feature';
import { PageHeader } from '@/components/ui/page-header';
import { buttonVariants } from '@/components/ui/button';

export async function AgentOrchestrationUpgradeState() {
  const t = await getTranslations('agents');

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-24 text-center">
      <PageHeader
        title={t('orchestrationGateTitle')}
        description={t('orchestrationGateDescription')}
      />
      <Link
        href="/pricing"
        className={buttonVariants({ variant: 'hero', size: 'lg' })}
      >
        {t('orchestrationGateAction')}
      </Link>
    </div>
  );
}

/**
 * Server component that gates agent orchestration pages.
 * When the org's plan does not include agent_orchestration, renders
 * an upgrade guidance surface instead of `children`.
 */
export async function AgentOrchestrationGate({
  orgId,
  children,
}: {
  orgId: string;
  children: React.ReactNode;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const check = await checkFeatureLimit(null as any, orgId, 'agent_orchestration');

  if (check.allowed) {
    return <>{children}</>;
  }

  return await AgentOrchestrationUpgradeState();
}
