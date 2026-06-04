'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
        <p className="text-sm font-medium text-foreground">{t('verifyStepTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('verifyStepBody')}</p>
      </div>

      <Alert variant={verificationCompleted ? 'success' : 'warning'}>
        {verificationCompleted ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
        <AlertTitle>{verificationCompleted ? t('verificationCompletedTitle') : t('verificationPendingTitle')}</AlertTitle>
        <AlertDescription>{verificationCompleted ? t('verificationCompletedBody', { name: deploymentName }) : t('verificationPendingBody', { name: deploymentName })}</AlertDescription>
      </Alert>

      <div className="grid gap-3 md:grid-cols-4">
        <GlassPanel className="border-white/8 bg-muted/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('verificationStatusLabel')}</div>
          <div className="mt-2 text-sm font-medium text-foreground">{deploymentStatus}</div>
          <div className="mt-2 text-xs text-muted-foreground">{lastDeployedAt ? new Date(lastDeployedAt).toLocaleString() : t('verificationStatusPending')}</div>
        </GlassPanel>
        <GlassPanel className="border-white/8 bg-muted/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('verificationResultLabel')}</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="text-sm font-medium text-foreground">{verificationCompleted ? t('verificationStatusValueCompleted') : t('verificationStatusValuePending')}</div>
            <Badge variant={verificationCompleted ? 'success' : 'outline'}>
              {verificationCompleted ? t('verificationStatusValueCompleted') : t('verificationStatusValuePending')}
            </Badge>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">{verificationCompletedAt ? t('verificationCompletedAtValue', { date: new Date(verificationCompletedAt).toLocaleString() }) : t('verificationPendingHint')}</div>
        </GlassPanel>
        <GlassPanel className="border-white/8 bg-muted/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('verificationScopeLabel')}</div>
          <div className="mt-2 text-sm font-medium text-foreground">{verificationScopeSummary}</div>
          <div className="mt-2 text-xs text-muted-foreground">{t('verificationModelValue', { provider: deploymentProviderLabel, model })}</div>
        </GlassPanel>
        <GlassPanel className="border-white/8 bg-muted/35 p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('verificationRoutingLabel')}</div>
          <div className="mt-2 text-sm font-medium text-foreground">{autoRoutingPreviewLabel}</div>
          <div className="mt-2 text-xs text-muted-foreground">{t('deployPreflightRoutingValue', { template: autoRoutingPreviewLabel, count: autoRoutingRuleCount })}</div>
        </GlassPanel>
      </div>

      <GlassPanel className="border-white/8 bg-muted/35 p-5">
        <div>
          <p className="text-sm font-medium text-foreground">{t('verificationChecklistTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('verificationChecklistBody')}</p>
        </div>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>{t('verificationCheckpointDashboard')}</li>
          <li>{t('verificationCheckpointRouting', { count: autoRoutingRuleCount })}</li>
          <li>{mcpValidationErrorCount !== null && mcpValidationErrorCount !== undefined ? t('verificationCheckpointMcp', { count: mcpValidationErrorCount }) : t('verificationCheckpointMcpFallback')}</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/agents" className={buttonVariants({ variant: 'hero', size: 'lg' })}>{t('verificationOpenDashboardCta')}</Link>
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
