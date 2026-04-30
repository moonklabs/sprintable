'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { AlertTriangle, CheckCircle2, Clock3, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { OperatorInput, OperatorSelect } from '@/components/ui/operator-control';
import type { HitlApprovalRule, HitlPolicySnapshot, HitlTimeoutClass } from '@/services/agent-hitl-policy';

const ESCALATION_MODE_OPTIONS: Array<HitlTimeoutClass['escalation_mode']> = ['timeout_memo', 'timeout_memo_and_escalate'];

function formatMinutesAsHours(minutes: number) {
  return Number((minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1));
}

function hoursToMinutes(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 60);
}

export function AgentHitlPolicyEditor() {
  const t = useTranslations('agentHitl');
  const common = useTranslations('common');
  const [policy, setPolicy] = useState<HitlPolicySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const supabase = createSupabaseBrowserClient();
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
    return headers;
  };

  const fetchPolicy = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch('/api/v2/hitl/policy', { headers: authHeaders });
      if (!response.ok) throw new Error(t('policyLoadFailed'));
      const json = await response.json() as { data?: HitlPolicySnapshot };
      if (!json.data) throw new Error(t('policyLoadFailed'));
      setPolicy(json.data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : t('policyLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const updateApprovalRule = useCallback((key: HitlApprovalRule['key'], timeoutClass: string) => {
    setPolicy((prev) => prev ? {
      ...prev,
      approval_rules: prev.approval_rules.map((rule) => rule.key === key
        ? { ...rule, timeout_class: timeoutClass as HitlApprovalRule['timeout_class'] }
        : rule),
    } : prev);
  }, []);

  const updateTimeoutClass = useCallback((key: HitlTimeoutClass['key'], field: 'duration_minutes' | 'reminder_minutes_before' | 'escalation_mode', value: string) => {
    setPolicy((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        timeout_classes: prev.timeout_classes.map((timeoutClass) => {
          if (timeoutClass.key !== key) return timeoutClass;
          if (field === 'escalation_mode') {
            return { ...timeoutClass, escalation_mode: value as HitlTimeoutClass['escalation_mode'] };
          }
          const nextMinutes = hoursToMinutes(value);
          if (nextMinutes == null) return timeoutClass;
          return { ...timeoutClass, [field]: nextMinutes } as HitlTimeoutClass;
        }),
      };
    });
  }, []);

  const savePolicy = useCallback(async () => {
    if (!policy) return;
    setSaving(true);
    setError(null);
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch('/api/v2/hitl/policy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          approval_rules: policy.approval_rules,
          timeout_classes: policy.timeout_classes,
        }),
      });
      const json = await response.json().catch(() => null) as { data?: HitlPolicySnapshot; error?: { message?: string } } | null;
      if (!response.ok || !json?.data) {
        throw new Error(json?.error?.message ?? t('policySaveFailed'));
      }
      setPolicy(json.data);
      setSavedAt(new Date().toISOString());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('policySaveFailed'));
    } finally {
      setSaving(false);
    }
  }, [policy, t]);

  if (loading) {
    return (
      <SectionCard>
        <SectionCardHeader>
          <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('policyLoadingTitle')}</h2>
        </SectionCardHeader>
        <SectionCardBody>
          <div className="space-y-3">
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-28 animate-pulse rounded-3xl bg-[color:var(--operator-surface-soft)]" />
            ))}
          </div>
        </SectionCardBody>
      </SectionCard>
    );
  }

  if (!policy) {
    return (
      <SectionCard>
        <SectionCardHeader>
          <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('policyTitle')}</h2>
        </SectionCardHeader>
        <SectionCardBody className="space-y-3">
          <p className="text-sm text-amber-100">{error ?? t('policyLoadFailed')}</p>
          <Button variant="glass" size="sm" onClick={() => void fetchPolicy()}>{t('refreshPolicy')}</Button>
        </SectionCardBody>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-white/8 bg-white/4 px-4 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--operator-muted)]">{t('policyEyebrow')}</p>
          <h2 className="mt-1 text-lg font-semibold text-[color:var(--operator-foreground)]">{t('policyTitle')}</h2>
          <p className="mt-1 text-sm text-[color:var(--operator-muted)]">{t('policyBody')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {savedAt ? <Badge variant="success">{t('policySaved')}</Badge> : null}
          <Button variant="glass" size="sm" onClick={() => void fetchPolicy()}>{t('refreshPolicy')}</Button>
          <Button variant="hero" size="sm" disabled={saving} onClick={() => void savePolicy()}>{saving ? t('policySaving') : common('save')}</Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-[color:var(--operator-primary-soft)]" />
              <div>
                <h3 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('catalogTitle')}</h3>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('catalogBody')}</p>
              </div>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-3">
            {policy.high_risk_actions.map((item) => (
              <div key={item.key} className="rounded-3xl border border-white/10 bg-white/4 px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.severity === 'critical' ? 'destructive' : 'info'}>{t(`catalogSeverity_${item.severity}`)}</Badge>
                  <Badge variant="outline">{t(`requestType_${item.default_request_type}`)}</Badge>
                  <Badge variant="chip">{t(`timeoutClass_${item.default_timeout_class}`)}</Badge>
                </div>
                <p className="mt-3 text-sm font-semibold text-[color:var(--operator-foreground)]">{t(`catalog_${item.key}_title`)}</p>
                <p className="mt-2 text-sm text-[color:var(--operator-muted)]">{t(`catalog_${item.key}_body`)}</p>
              </div>
            ))}
          </SectionCardBody>
        </SectionCard>

        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-[color:var(--operator-primary-soft)]" />
              <div>
                <h3 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('approvalTitle')}</h3>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('approvalBody')}</p>
              </div>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-3">
            {policy.approval_rules.map((rule) => (
              <div key={rule.key} className="rounded-3xl border border-white/10 bg-white/4 px-4 py-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="info">{t('approvalRequired')}</Badge>
                  <Badge variant="outline">{t(`timeoutClass_${rule.timeout_class}`)}</Badge>
                </div>
                <div>
                  <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t(`approval_${rule.key}_title`)}</p>
                  <p className="mt-1 text-sm text-[color:var(--operator-muted)]">{t(`approval_${rule.key}_body`)}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">
                    <span>{t('approvalRequestTypeLabel')}</span>
                    <div className="flex h-10 items-center rounded-2xl border border-white/10 bg-[color:var(--operator-surface-soft)] px-3 text-sm font-medium normal-case tracking-normal text-[color:var(--operator-foreground)]">
                      {t('requestType_approval')}
                    </div>
                  </label>
                  <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">
                    <span>{t('approvalTimeoutClassLabel')}</span>
                    <OperatorSelect value={rule.timeout_class} onChange={(event) => updateApprovalRule(rule.key, event.target.value)}>
                      {policy.timeout_classes.map((timeoutClass) => (
                        <option key={timeoutClass.key} value={timeoutClass.key}>{t(`timeoutClass_${timeoutClass.key}`)}</option>
                      ))}
                    </OperatorSelect>
                  </label>
                </div>
              </div>
            ))}
          </SectionCardBody>
        </SectionCard>

        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center gap-2">
              <Clock3 className="size-4 text-[color:var(--operator-primary-soft)]" />
              <div>
                <h3 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('timeoutTitle')}</h3>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('timeoutBody')}</p>
              </div>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-3">
            {policy.timeout_classes.map((timeoutClass) => {
              const linkedRules = policy.approval_rules.filter((rule) => rule.timeout_class === timeoutClass.key);
              return (
                <div key={timeoutClass.key} className="rounded-3xl border border-white/10 bg-white/4 px-4 py-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="chip">{t(`timeoutClass_${timeoutClass.key}`)}</Badge>
                    {linkedRules.map((rule) => (
                      <Badge key={rule.key} variant="outline">{t(`approval_${rule.key}_short`)}</Badge>
                    ))}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t(`timeout_${timeoutClass.key}_title`)}</p>
                    <p className="mt-1 text-sm text-[color:var(--operator-muted)]">{t(`timeout_${timeoutClass.key}_body`)}</p>
                  </div>
                  <div className="grid gap-3">
                    <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">
                      <span>{t('timeoutDurationLabel')}</span>
                      <OperatorInput
                        type="number"
                        min={0.5}
                        step={0.5}
                        value={String(formatMinutesAsHours(timeoutClass.duration_minutes))}
                        onChange={(event) => updateTimeoutClass(timeoutClass.key, 'duration_minutes', event.target.value)}
                      />
                    </label>
                    <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">
                      <span>{t('timeoutReminderLabel')}</span>
                      <OperatorInput
                        type="number"
                        min={0.25}
                        step={0.25}
                        value={String(formatMinutesAsHours(timeoutClass.reminder_minutes_before))}
                        onChange={(event) => updateTimeoutClass(timeoutClass.key, 'reminder_minutes_before', event.target.value)}
                      />
                    </label>
                    <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">
                      <span>{t('timeoutEscalationLabel')}</span>
                      <OperatorSelect value={timeoutClass.escalation_mode} onChange={(event) => updateTimeoutClass(timeoutClass.key, 'escalation_mode', event.target.value)}>
                        {ESCALATION_MODE_OPTIONS.map((mode) => (
                          <option key={mode} value={mode}>{t(`escalationMode_${mode}`)}</option>
                        ))}
                      </OperatorSelect>
                    </label>
                  </div>
                </div>
              );
            })}
          </SectionCardBody>
        </SectionCard>
      </div>

      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-[color:var(--operator-primary-soft)]" />
            <div>
              <h3 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('policySummaryTitle')}</h3>
              <p className="text-sm text-[color:var(--operator-muted)]">{t('policySummaryBody')}</p>
            </div>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          <pre className="whitespace-pre-wrap rounded-3xl border border-white/10 bg-slate-950/40 px-4 py-4 text-sm text-[color:var(--operator-muted)]">{policy.prompt_summary}</pre>
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
