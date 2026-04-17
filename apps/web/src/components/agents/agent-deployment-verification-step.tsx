'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import type { ManagedAgentDeploymentVerification } from '@/lib/managed-agent-contract';

interface AgentDeploymentVerificationStepProps {
  deploymentName: string;
  deploymentStatus: string;
  lastDeployedAt?: string | null;
  verification?: ManagedAgentDeploymentVerification | null;
  verificationScopeSummary: string;
  deploymentProviderLabel: string;
  model: string;
  autoRoutingPreviewLabel: string;
  autoRoutingRuleCount: number;
  mcpValidationErrorCount?: number | null;
  verificationSubmitting: boolean;
  onCompleteVerification: () => void;
}

export function AgentDeploymentVerificationStep({
  deploymentName,
  deploymentStatus,
  lastDeployedAt,
  verification,
  verificationScopeSummary,
  deploymentProviderLabel,
  model,
  autoRoutingPreviewLabel,
  autoRoutingRuleCount,
  mcpValidationErrorCount,
  verificationSubmitting,
  onCompleteVerification,
}: AgentDeploymentVerificationStepProps) {
  const t = useTranslations('agents');
  const verificationStatus = verification?.status ?? 'pending';
  const verificationCompleted = verificationStatus === 'completed';
  const verificationCompletedAt = verification?.completed_at ?? null;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('verifyStepTitle')}</p>
        <p className="text-sm text-[color:var(--operator-muted)]">{t('verifyStepBody')}</p>
      </div>

      <div className={`rounded-2xl px-4 py-4 text-sm ${verificationCompleted ? 'border border-emerald-400/18 bg-emerald-400/10 text-emerald-100' : 'border border-amber-400/16 bg-amber-400/10 text-amber-100'}`}>
        <div className="flex items-start gap-3">
          {verificationCompleted ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
          <div className="space-y-1">
            <p className="font-medium">{verificationCompleted ? t('verificationCompletedTitle') : t('verificationPendingTitle')}</p>
            <p>{verificationCompleted ? t('verificationCompletedBody', { name: deploymentName }) : t('verificationPendingBody', { name: deploymentName })}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('verificationStatusLabel')}</div>
          <div className="mt-2 text-sm font-medium text-[color:var(--operator-foreground)]">{deploymentStatus}</div>
          <div className="mt-2 text-xs text-[color:var(--operator-muted)]">{lastDeployedAt ? new Date(lastDeployedAt).toLocaleString() : t('verificationStatusPending')}</div>
        </GlassPanel>
        <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('verificationResultLabel')}</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="text-sm font-medium text-[color:var(--operator-foreground)]">{verificationCompleted ? t('verificationStatusValueCompleted') : t('verificationStatusValuePending')}</div>
            <Badge variant={verificationCompleted ? 'success' : 'outline'}>
              {verificationCompleted ? t('verificationStatusValueCompleted') : t('verificationStatusValuePending')}
            </Badge>
          </div>
          <div className="mt-2 text-xs text-[color:var(--operator-muted)]">{verificationCompletedAt ? t('verificationCompletedAtValue', { date: new Date(verificationCompletedAt).toLocaleString() }) : t('verificationPendingHint')}</div>
        </GlassPanel>
        <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('verificationScopeLabel')}</div>
          <div className="mt-2 text-sm font-medium text-[color:var(--operator-foreground)]">{verificationScopeSummary}</div>
          <div className="mt-2 text-xs text-[color:var(--operator-muted)]">{t('verificationModelValue', { provider: deploymentProviderLabel, model })}</div>
        </GlassPanel>
        <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('verificationRoutingLabel')}</div>
          <div className="mt-2 text-sm font-medium text-[color:var(--operator-foreground)]">{autoRoutingPreviewLabel}</div>
          <div className="mt-2 text-xs text-[color:var(--operator-muted)]">{t('deployPreflightRoutingValue', { template: autoRoutingPreviewLabel, count: autoRoutingRuleCount })}</div>
        </GlassPanel>
      </div>

      <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-5">
        <div>
          <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('verificationChecklistTitle')}</p>
          <p className="text-sm text-[color:var(--operator-muted)]">{t('verificationChecklistBody')}</p>
        </div>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-[color:var(--operator-muted)]">
          <li>{t('verificationCheckpointDashboard')}</li>
          <li>{t('verificationCheckpointRouting', { count: autoRoutingRuleCount })}</li>
          <li>{mcpValidationErrorCount !== null && mcpValidationErrorCount !== undefined ? t('verificationCheckpointMcp', { count: mcpValidationErrorCount }) : t('verificationCheckpointMcpFallback')}</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/agents" className={buttonVariants({ variant: 'hero', size: 'lg' })}>{t('verificationOpenDashboardCta')}</Link>
          <Link href="/agents/workflow" className={buttonVariants({ variant: 'glass', size: 'lg' })}>{t('verificationOpenWorkflowCta')}</Link>
          <Link href="/dashboard/settings" className={buttonVariants({ variant: 'glass', size: 'lg' })}>{t('verificationOpenSettingsCta')}</Link>
          {!verificationCompleted ? (
            <Button variant="glass" size="lg" disabled={verificationSubmitting} onClick={onCompleteVerification}>
              {verificationSubmitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}
              {verificationSubmitting ? t('verificationCompletingCta') : t('verificationCompleteCta')}
            </Button>
          ) : null}
        </div>
      </GlassPanel>
    </div>
  );
}
