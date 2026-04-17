'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Bot, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Rocket, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GlassPanel } from '@/components/ui/glass-panel';
import { OperatorInput, OperatorSelect } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { AgentDeploymentVerificationStep } from '@/components/agents/agent-deployment-verification-step';
import { ANTHROPIC_MODELS, GOOGLE_MODELS, GROQ_MODELS, LLMProvider, OPENAI_MODELS } from '@/lib/llm/types';
import type { ManagedAgentDeploymentVerification } from '@/lib/managed-agent-contract';
import { buildAutomaticRoutingTemplate, resolveAutoRoutingPersonaRole, type AutoRoutingPersonaRole } from '@/services/agent-routing-template';

export interface WizardAgent {
  id: string;
  name: string;
}

export interface WizardPersona {
  id: string;
  name: string;
  description: string | null;
  is_builtin: boolean;
  project_name?: string | null;
  agent_name?: string | null;
  slug?: string | null;
  base_persona_slug?: string | null;
  role?: AutoRoutingPersonaRole;
}

export interface WizardExistingDeployment {
  id: string;
  agentId: string;
  agentName: string;
  personaId: string | null;
  role: AutoRoutingPersonaRole;
}

export interface WizardProject {
  id: string;
  name: string;
}

export interface WizardDefaults {
  provider: LLMProvider;
  model: string;
  hasProjectApiKey: boolean;
  projectAiProvider: LLMProvider | null;
}

interface AgentDeploymentWizardProps {
  agent: WizardAgent | null;
  personas: WizardPersona[];
  projects: WizardProject[];
  currentProjectId: string;
  currentProjectName: string | null;
  defaults: WizardDefaults;
  existingDeployments: WizardExistingDeployment[];
  existingRoutingRuleCount: number;
}

type ScopeMode = 'org' | 'projects';
type ModelMode = 'managed' | 'byom';

interface DeploymentPreflightSummary {
  ok: boolean;
  checked_at: string;
  blocking_reasons: string[];
  warnings: string[];
  routing_template_id: string;
  routing_rule_count: number;
  existing_routing_rule_count: number;
  requires_routing_overwrite_confirmation: boolean;
  mcp_validation_errors: string[];
}

interface CompletedDeployment {
  id: string;
  name: string;
  status: string;
  runtime: string;
  model: string | null;
  config: {
    scope_mode?: ScopeMode;
    project_ids?: string[];
    verification?: ManagedAgentDeploymentVerification | null;
  } | null;
  last_deployed_at?: string | null;
  failure_message?: string | null;
}

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  groq: 'Groq',
  'openai-compatible': 'OpenAI-compatible',
};

const STEP_KEYS = ['persona', 'model', 'scope', 'review', 'verify'] as const;
const STEP_ICONS = [Sparkles, Bot, CheckCircle2, Rocket, CheckCircle2] as const;

function getModels(provider: LLMProvider) {
  switch (provider) {
    case 'anthropic': return ANTHROPIC_MODELS;
    case 'google': return GOOGLE_MODELS;
    case 'groq': return GROQ_MODELS;
    case 'openai-compatible': return [];
    case 'openai':
    default:
      return OPENAI_MODELS;
  }
}

function getDefaultModel(provider: LLMProvider) {
  return getModels(provider)[0] ?? 'gpt-4o-mini';
}

export function AgentDeploymentWizard({
  agent,
  personas,
  projects,
  currentProjectId,
  currentProjectName,
  defaults,
  existingDeployments,
  existingRoutingRuleCount,
}: AgentDeploymentWizardProps) {
  const t = useTranslations('agents');
  const tc = useTranslations('common');
  const { addToast, dismissToast, toasts } = useToast();

  const [step, setStep] = useState(0);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>(personas[0]?.id ?? '');
  const [deploymentName, setDeploymentName] = useState(personas[0]?.name ? `${personas[0].name} deployment` : '');
  const [modelMode, setModelMode] = useState<ModelMode>('managed');
  const [provider, setProvider] = useState<LLMProvider>(defaults.provider);
  const [model, setModel] = useState(defaults.model || getDefaultModel(defaults.provider));
  const lockedByomProvider = modelMode === 'byom' ? defaults.projectAiProvider : null;
  const deploymentProvider = lockedByomProvider ?? provider;
  const deploymentProviderLabel = PROVIDER_LABELS[deploymentProvider];
  const [scopeMode, setScopeMode] = useState<ScopeMode>('projects');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([currentProjectId]);
  const [deploying, setDeploying] = useState(false);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [preflight, setPreflight] = useState<DeploymentPreflightSummary | null>(null);
  const [preflightFingerprintUsed, setPreflightFingerprintUsed] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<string | null>(null);
  const [completedDeployment, setCompletedDeployment] = useState<CompletedDeployment | null>(null);
  const [verificationSubmitting, setVerificationSubmitting] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [overwriteRoutingRules, setOverwriteRoutingRules] = useState(false);

  const builtinPersonas = personas.filter((persona) => persona.is_builtin);
  const customPersonas = personas.filter((persona) => !persona.is_builtin);
  const selectedPersona = personas.find((persona) => persona.id === selectedPersonaId) ?? null;
  const modelOptions = useMemo(() => getModels(deploymentProvider), [deploymentProvider]);
  const autoRoutingMemoTypeLabels = useMemo(() => ({
    requirement: t('workflowMemoTypeRequirement'),
    user_story: t('workflowMemoTypeUserStory'),
    task: t('workflowMemoTypeTask'),
    dev_task: t('workflowMemoTypeDevTask'),
    review: t('workflowMemoTypeReview'),
  }), [t]);
  const selectedPersonaRole = selectedPersona?.role ?? resolveAutoRoutingPersonaRole({
    slug: selectedPersona?.slug ?? null,
    basePersonaSlug: selectedPersona?.base_persona_slug ?? null,
  });
  const autoRoutingPreview = useMemo(() => {
    if (!agent) {
      return buildAutomaticRoutingTemplate({
        agents: [],
        existingRuleCount: existingRoutingRuleCount,
      });
    }

    return buildAutomaticRoutingTemplate({
      agents: [
        ...existingDeployments.map((deployment) => ({
          agentId: deployment.agentId,
          agentName: deployment.agentName,
          role: deployment.role,
          personaId: deployment.personaId,
          deploymentId: deployment.id,
        })),
        {
          agentId: agent.id,
          agentName: agent.name,
          role: selectedPersonaRole,
          personaId: selectedPersona?.id ?? null,
          deploymentId: null,
        },
      ],
      existingRuleCount: existingRoutingRuleCount,
    });
  }, [agent, existingDeployments, existingRoutingRuleCount, selectedPersona, selectedPersonaRole]);
  const autoRoutingPreviewLabel = useMemo(() => {
    if (autoRoutingPreview.templateId === 'po-dev-qa') return t('autoRoutingTemplatePoDevQa');
    if (autoRoutingPreview.templateId === 'po-dev') return t('autoRoutingTemplatePoDev');
    if (autoRoutingPreview.templateId === 'solo-dev') return t('autoRoutingTemplateSoloDev');
    return t('autoRoutingTemplateNone');
  }, [autoRoutingPreview.templateId, t]);
  const formatAutoRoutingMemoTypes = (memoTypes: string[]) => memoTypes
    .map((memoType) => autoRoutingMemoTypeLabels[memoType as keyof typeof autoRoutingMemoTypeLabels] ?? memoType)
    .join(', ');
  const deploymentPayload = useMemo(() => {
    if (!agent || !selectedPersonaId) return null;
    return {
      agent_id: agent.id,
      name: deploymentName || `${selectedPersona?.name ?? t('defaultDeploymentName')} deployment`,
      runtime: 'webhook',
      model,
      persona_id: selectedPersonaId,
      config: {
        schema_version: 1,
        llm_mode: modelMode,
        provider: deploymentProvider,
        scope_mode: scopeMode,
        project_ids: scopeMode === 'org' ? projects.map((project) => project.id) : selectedProjectIds,
      },
      overwrite_routing_rules: autoRoutingPreview.requiresOverwriteConfirmation ? overwriteRoutingRules : undefined,
    };
  }, [agent, autoRoutingPreview.requiresOverwriteConfirmation, deploymentName, deploymentProvider, model, modelMode, overwriteRoutingRules, projects, scopeMode, selectedPersona?.name, selectedPersonaId, selectedProjectIds, t]);
  const preflightFingerprint = useMemo(() => JSON.stringify(deploymentPayload ?? {}), [deploymentPayload]);
  const verificationScopeSummary = useMemo(() => {
    const scopeModeValue = completedDeployment?.config?.scope_mode ?? scopeMode;
    const projectIds = completedDeployment?.config?.project_ids ?? (scopeModeValue === 'org' ? projects.map((project) => project.id) : selectedProjectIds);
    return scopeModeValue === 'org'
      ? t('scopeAllProjects')
      : projectIds.map((projectId) => projects.find((project) => project.id === projectId)?.name ?? projectId).join(', ');
  }, [completedDeployment?.config?.project_ids, completedDeployment?.config?.scope_mode, projects, scopeMode, selectedProjectIds, t]);

  useEffect(() => {
    if (!selectedPersona) return;
    setDeploymentName((current) => (current.trim() ? current : `${selectedPersona.name} deployment`));
  }, [selectedPersona]);

  useEffect(() => {
    if (modelMode === 'byom' && defaults.projectAiProvider && provider !== defaults.projectAiProvider) {
      setProvider(defaults.projectAiProvider);
    }
  }, [defaults.projectAiProvider, modelMode, provider]);

  useEffect(() => {
    if (!modelOptions.length) return;
    if (!modelOptions.includes(model as never)) {
      setModel(getDefaultModel(deploymentProvider));
    }
  }, [deploymentProvider, model, modelOptions]);

  useEffect(() => {
    if (!autoRoutingPreview.requiresOverwriteConfirmation) {
      setOverwriteRoutingRules(false);
    }
  }, [autoRoutingPreview.requiresOverwriteConfirmation, autoRoutingPreview.templateId, selectedPersonaId]);

  useEffect(() => {
    if (preflightFingerprintUsed === null) return;
    if (preflightFingerprintUsed === preflightFingerprint) return;
    setPreflight(null);
    setPreflightFingerprintUsed(null);
    setDeploymentId(null);
    setDeploymentStatus(null);
    setCompletedDeployment(null);
    setVerificationSubmitting(false);
  }, [preflightFingerprint, preflightFingerprintUsed]);

  useEffect(() => {
    if (!deploymentId || !deploying) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/v1/agent-deployments/${deploymentId}`, { cache: 'no-store' });
      const json = await response.json();
      if (!response.ok) {
        if (!cancelled) {
          setDeploying(false);
          setFailureMessage(json?.error?.message ?? t('deployStatusLoadFailed'));
        }
        return;
      }

      const nextStatus = json.data?.status as string | undefined;
      if (!nextStatus || cancelled) return;
      setDeploymentStatus(nextStatus);

      if (nextStatus === 'ACTIVE') {
        setDeploying(false);
        setCompletedDeployment(json.data as CompletedDeployment);
        setStep(STEP_KEYS.length - 1);
        addToast({ title: t('deploySuccessToastTitle'), body: t('deploySuccessToastBody', { name: deploymentName }), type: 'success' });
      }

      if (nextStatus === 'DEPLOY_FAILED') {
        setDeploying(false);
        setCompletedDeployment(json.data as CompletedDeployment);
        setFailureMessage(json.data?.failure_message ?? t('deployFailedBody'));
      }
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [addToast, deploymentId, deploymentName, deploying, t]);

  const summaryItems = useMemo(() => {
    const scopeSummary = scopeMode === 'org'
      ? t('scopeAllProjects')
      : selectedProjectIds.map((projectId) => projects.find((project) => project.id === projectId)?.name ?? projectId).join(', ');

    return [
      { label: t('reviewPersona'), value: selectedPersona?.name ?? t('noneSelected') },
      { label: t('reviewModel'), value: `${deploymentProviderLabel} · ${modelMode === 'managed' ? t('modeManaged') : t('modeByom')}` },
      { label: t('reviewModelId'), value: model },
      { label: t('reviewScope'), value: scopeSummary },
      { label: t('reviewDeploymentName'), value: deploymentName || t('noneSelected') },
      { label: t('reviewAutoRouting'), value: autoRoutingPreviewLabel },
    ];
  }, [autoRoutingPreviewLabel, deploymentName, deploymentProviderLabel, model, modelMode, projects, scopeMode, selectedPersona?.name, selectedProjectIds, t]);

  const canAdvance = (() => {
    if (step === 0) return Boolean(selectedPersonaId);
    if (step === 1) return Boolean(model.trim()) && (modelMode === 'managed' || defaults.hasProjectApiKey);
    if (step === 2) return scopeMode === 'org' || selectedProjectIds.length > 0;
    return true;
  })();
  const canDeploy = Boolean(preflight?.ok) && preflightFingerprintUsed === preflightFingerprint;

  const handleRunPreflight = async () => {
    if (!deploymentPayload) return false;
    setPreflightRunning(true);
    setFailureMessage(null);
    try {
      const response = await fetch('/api/v1/agent-deployments/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deploymentPayload),
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error?.message ?? t('deployPreflightFailedBody'));
      }

      const nextPreflight = (json.data?.preflight ?? null) as DeploymentPreflightSummary | null;
      setPreflight(nextPreflight);
      setPreflightFingerprintUsed(preflightFingerprint);
      return Boolean(nextPreflight?.ok);
    } catch (error) {
      addToast({ title: t('deployPreflightFailedTitle'), body: error instanceof Error ? error.message : t('deployPreflightFailedBody'), type: 'warning' });
      return false;
    } finally {
      setPreflightRunning(false);
    }
  };

  const handleDeploy = async () => {
    if (!deploymentPayload) return;
    const preflightReady = canDeploy || await handleRunPreflight();
    if (!preflightReady) return;

    setDeploying(true);
    setFailureMessage(null);
    setDeploymentStatus('DEPLOYING');
    try {
      const response = await fetch('/api/v1/agent-deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deploymentPayload),
      });

      const json = await response.json();
      if (!response.ok) {
        if (json?.error?.code === 'DEPLOYMENT_PREFLIGHT_FAILED' && json?.error?.details?.preflight) {
          setDeploying(false);
          setPreflight(json.error.details.preflight as DeploymentPreflightSummary);
          setPreflightFingerprintUsed(preflightFingerprint);
          addToast({ title: t('deployPreflightBlockedTitle'), body: json?.error?.message ?? t('deployPreflightBlockedBody'), type: 'warning' });
          return;
        }
        throw new Error(json?.error?.message ?? t('deployFailedBody'));
      }

      const nextDeployment = (json.data?.deployment ?? null) as CompletedDeployment | null;
      setDeploymentId(nextDeployment?.id ?? null);
      setDeploymentStatus(nextDeployment?.status ?? 'DEPLOYING');

      if (nextDeployment?.status === 'ACTIVE') {
        setDeploying(false);
        setCompletedDeployment(nextDeployment);
        setStep(STEP_KEYS.length - 1);
        addToast({ title: t('deploySuccessToastTitle'), body: t('deploySuccessToastBody', { name: deploymentName }), type: 'success' });
        return;
      }

      if (nextDeployment?.status === 'DEPLOY_FAILED') {
        setDeploying(false);
        setCompletedDeployment(nextDeployment);
        setFailureMessage(nextDeployment.failure_message ?? t('deployFailedBody'));
      }
    } catch (error) {
      setDeploying(false);
      addToast({ title: t('deployFailedTitle'), body: error instanceof Error ? error.message : t('deployFailedBody'), type: 'warning' });
    }
  };

  const handleCompleteVerification = async () => {
    if (!deploymentId) return;
    setVerificationSubmitting(true);
    try {
      const response = await fetch(`/api/v1/agent-deployments/${deploymentId}/verification`, {
        method: 'POST',
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error?.message ?? t('verificationCompleteFailedBody'));
      }
      const nextDeployment = (json.data?.deployment ?? null) as CompletedDeployment | null;
      if (nextDeployment) {
        setCompletedDeployment(nextDeployment);
        setDeploymentStatus(nextDeployment.status ?? deploymentStatus ?? 'ACTIVE');
      }
      addToast({
        title: t('verificationCompleteSuccessTitle'),
        body: t('verificationCompleteSuccessBody', { name: nextDeployment?.name ?? deploymentName }),
        type: 'success',
      });
    } catch (error) {
      addToast({
        title: t('verificationCompleteFailedTitle'),
        body: error instanceof Error ? error.message : t('verificationCompleteFailedBody'),
        type: 'warning',
      });
    } finally {
      setVerificationSubmitting(false);
    }
  };

  const toggleProject = (projectId: string) => {
    setSelectedProjectIds((current) => (
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId]
    ));
  };

  const renderStep = () => {
    if (!agent) {
      return (
        <GlassPanel className="border-dashed border-white/14 bg-[color:var(--operator-surface-soft)]/28 p-6 text-center">
          <AlertTriangle className="mx-auto size-9 text-amber-300" />
          <h3 className="mt-4 text-lg font-semibold text-[color:var(--operator-foreground)]">{t('noAgentTitle')}</h3>
          <p className="mt-2 text-sm text-[color:var(--operator-muted)]">{t('noAgentBody')}</p>
        </GlassPanel>
      );
    }

    if (!personas.length) {
      return (
        <GlassPanel className="border-dashed border-white/14 bg-[color:var(--operator-surface-soft)]/28 p-6 text-center">
          <Sparkles className="mx-auto size-9 text-[color:var(--operator-primary-soft)]" />
          <h3 className="mt-4 text-lg font-semibold text-[color:var(--operator-foreground)]">{t('emptyPersonasTitle')}</h3>
          <p className="mt-2 text-sm text-[color:var(--operator-muted)]">{t('emptyPersonasBody')}</p>
          <div className="mt-5">
            <Link href="/agents/personas/new" className={buttonVariants({ variant: 'hero', size: 'lg' })}>{t('createCustomPersona')}</Link>
          </div>
        </GlassPanel>
      );
    }

    if (step === 0) {
      return (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('personaStepTitle')}</p>
              <p className="text-sm text-[color:var(--operator-muted)]">{t('personaStepBody')}</p>
            </div>
            <Link href="/agents/personas/new" className={buttonVariants({ variant: 'glass', size: 'lg' })}>{t('createCustomPersona')}</Link>
          </div>
          {[{ label: t('builtInPersonas'), personas: builtinPersonas }, { label: t('customPersonas'), personas: customPersonas }].map((group) => (
            <div key={group.label} className="space-y-3">
              <div className="text-xs uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{group.label}</div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {group.personas.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-white/12 bg-white/4 px-4 py-5 text-sm text-[color:var(--operator-muted)]">
                    {t('emptyPersonaGroup')}
                  </div>
                ) : group.personas.map((persona) => {
                  const selected = persona.id === selectedPersonaId;
                  return (
                    <button
                      key={persona.id}
                      type="button"
                      onClick={() => {
                        setSelectedPersonaId(persona.id);
                        setDeploymentName(`${persona.name} deployment`);
                      }}
                      className={`rounded-3xl border px-4 py-4 text-left transition ${selected ? 'border-[color:var(--operator-primary)]/45 bg-[color:var(--operator-primary)]/12 shadow-[0_18px_40px_rgba(102,102,255,0.16)]' : 'border-white/10 bg-white/4 hover:bg-white/8'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{persona.name}</h3>
                            <Badge variant={persona.is_builtin ? 'success' : 'outline'}>{persona.is_builtin ? t('builtInBadge') : t('customBadge')}</Badge>
                          </div>
                          <p className="text-sm leading-6 text-[color:var(--operator-muted)]">{persona.description ?? t('personaDescriptionFallback')}</p>
                          {!persona.is_builtin && (persona.project_name || persona.agent_name) ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--operator-muted)]">
                              {persona.project_name ? <Badge variant="outline">{t('personaProjectBadge', { project: persona.project_name })}</Badge> : null}
                              {persona.agent_name ? <Badge variant="outline">{t('personaAgentBadge', { agent: persona.agent_name })}</Badge> : null}
                            </div>
                          ) : null}
                        </div>
                        {selected ? <CheckCircle2 className="size-5 text-[color:var(--operator-primary-soft)]" /> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (step === 1) {
      return (
        <div className="space-y-5">
          <div>
            <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('modelStepTitle')}</p>
            <p className="text-sm text-[color:var(--operator-muted)]">{t('modelStepBody')}</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {(['managed', 'byom'] as ModelMode[]).map((mode) => {
              const selected = modelMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setModelMode(mode)}
                  className={`rounded-3xl border px-4 py-4 text-left transition ${selected ? 'border-[color:var(--operator-primary)]/45 bg-[color:var(--operator-primary)]/12' : 'border-white/10 bg-white/4 hover:bg-white/8'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{mode === 'managed' ? t('modeManaged') : t('modeByom')}</p>
                      <p className="mt-1 text-sm text-[color:var(--operator-muted)]">{mode === 'managed' ? t('modeManagedBody') : t('modeByomBody')}</p>
                    </div>
                    {selected ? <CheckCircle2 className="size-5 text-[color:var(--operator-primary-soft)]" /> : null}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-1">
              <label className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('providerLabel')}</label>
              <OperatorSelect value={deploymentProvider} onChange={(event) => setProvider(event.target.value as LLMProvider)} disabled={Boolean(lockedByomProvider)}>
                {(['openai', 'anthropic', 'google', 'groq', 'openai-compatible'] as LLMProvider[]).map((option) => (
                  <option key={option} value={option}>{PROVIDER_LABELS[option]}</option>
                ))}
              </OperatorSelect>
              {lockedByomProvider ? (
                <p className="text-xs text-[color:var(--operator-muted)]">{t('byomProviderLockedHint', { provider: deploymentProviderLabel })}</p>
              ) : null}
            </div>
            <div className="space-y-2 lg:col-span-1">
              <label className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('modelLabel')}</label>
              {modelOptions.length > 0 ? (
                <OperatorSelect value={model} onChange={(event) => setModel(event.target.value)}>
                  {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </OperatorSelect>
              ) : (
                <OperatorInput value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
              )}
            </div>
            <div className="space-y-2 lg:col-span-1">
              <label className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('deploymentNameLabel')}</label>
              <OperatorInput value={deploymentName} onChange={(event) => setDeploymentName(event.target.value)} placeholder={t('deploymentNamePlaceholder')} />
            </div>
          </div>

          {modelMode === 'byom' ? (
            <div className={`rounded-2xl border px-4 py-3 text-sm ${defaults.hasProjectApiKey ? 'border-sky-400/16 bg-sky-400/10 text-sky-100' : 'border-amber-400/18 bg-amber-400/10 text-amber-100'}`}>
              <p>{defaults.hasProjectApiKey ? t('byomHintWithDefaults', { provider: deploymentProviderLabel }) : t('byomHintWithoutDefaults')}</p>
              {!defaults.hasProjectApiKey ? (
                <div className="mt-3">
                  <Link href="/dashboard/settings" className={buttonVariants({ variant: 'glass', size: 'sm' })}>{t('configureProjectAi')}</Link>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-emerald-400/16 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
              {t('managedHint')}
            </div>
          )}
        </div>
      );
    }

    if (step === 2) {
      return (
        <div className="space-y-5">
          <div>
            <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('scopeStepTitle')}</p>
            <p className="text-sm text-[color:var(--operator-muted)]">{t('scopeStepBody')}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {(['org', 'projects'] as ScopeMode[]).map((mode) => {
              const selected = scopeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setScopeMode(mode)}
                  className={`rounded-3xl border px-4 py-4 text-left transition ${selected ? 'border-[color:var(--operator-primary)]/45 bg-[color:var(--operator-primary)]/12' : 'border-white/10 bg-white/4 hover:bg-white/8'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{mode === 'org' ? t('scopeAllProjects') : t('scopeSpecificProjects')}</p>
                      <p className="mt-1 text-sm text-[color:var(--operator-muted)]">{mode === 'org' ? t('scopeAllProjectsBody') : t('scopeSpecificProjectsBody')}</p>
                    </div>
                    {selected ? <CheckCircle2 className="size-5 text-[color:var(--operator-primary-soft)]" /> : null}
                  </div>
                </button>
              );
            })}
          </div>

          {scopeMode === 'projects' ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => {
                const selected = selectedProjectIds.includes(project.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => toggleProject(project.id)}
                    className={`rounded-3xl border px-4 py-4 text-left transition ${selected ? 'border-[color:var(--operator-primary)]/45 bg-[color:var(--operator-primary)]/12' : 'border-white/10 bg-white/4 hover:bg-white/8'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[color:var(--operator-foreground)]">{project.name}</p>
                        <p className="mt-1 text-xs text-[color:var(--operator-muted)]">{project.id === currentProjectId ? t('scopeCurrentProject') : t('scopeAdditionalProject')}</p>
                      </div>
                      {selected ? <CheckCircle2 className="size-5 text-[color:var(--operator-primary-soft)]" /> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
              {t('scopeAllProjectsHint', { count: projects.length })}
            </div>
          )}
        </div>
      );
    }

    if (step === 3) {
      return (
        <div className="space-y-5">
          <div>
            <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('reviewStepTitle')}</p>
            <p className="text-sm text-[color:var(--operator-muted)]">{t('reviewStepBody')}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {summaryItems.map((item) => (
              <GlassPanel key={item.label} className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{item.label}</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--operator-foreground)]">{item.value}</div>
              </GlassPanel>
            ))}
          </div>

          <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-5">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('autoRoutingPreviewTitle')}</p>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('autoRoutingPreviewBody')}</p>
              </div>
              <Badge variant="chip">{autoRoutingPreviewLabel}</Badge>
            </div>

            {autoRoutingPreview.rules.length > 0 ? (
              <div className="mt-4 space-y-3">
                {autoRoutingPreview.rules.map((rule) => (
                  <div key={`${rule.agent_id}-${rule.priority}`} className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                    <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{rule.name}</div>
                    <div className="mt-1 text-sm text-[color:var(--operator-muted)]">{formatAutoRoutingMemoTypes(rule.conditions.memo_type)}</div>
                  </div>
                ))}
              </div>
            ) : autoRoutingPreview.templateId === 'solo-dev' ? (
              <div className="mt-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
                {t('autoRoutingPreviewSoloBody')}
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
                {t('autoRoutingPreviewNoneBody')}
              </div>
            )}

            {autoRoutingPreview.requiresOverwriteConfirmation && autoRoutingPreview.rules.length > 0 ? (
              <div className="mt-4 rounded-2xl border border-amber-400/16 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-3">
                    <p>{t('autoRoutingOverwriteWarning', { count: autoRoutingPreview.existingRuleCount })}</p>
                    <label className="flex items-start gap-3 text-sm text-amber-50">
                      <input
                        type="checkbox"
                        checked={overwriteRoutingRules}
                        onChange={(event) => setOverwriteRoutingRules(event.target.checked)}
                        className="mt-1 h-4 w-4 accent-[color:var(--operator-primary)]"
                      />
                      <span>{t('autoRoutingOverwriteConfirm')}</span>
                    </label>
                  </div>
                </div>
              </div>
            ) : null}
          </GlassPanel>

          <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/35 p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('deployPreflightTitle')}</p>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('deployPreflightBody')}</p>
              </div>
              <Badge variant={preflight ? (preflight.ok ? 'success' : 'destructive') : 'outline'}>
                {preflight ? (preflight.ok ? t('deployPreflightReadyBadge') : t('deployPreflightBlockedBadge')) : t('deployPreflightPendingBadge')}
              </Badge>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('deployPreflightScopeLabel')}</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--operator-foreground)]">{verificationScopeSummary}</div>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('deployPreflightRoutingLabel')}</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--operator-foreground)]">{t('deployPreflightRoutingValue', { template: autoRoutingPreviewLabel, count: autoRoutingPreview.rules.length })}</div>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('deployPreflightCheckedAtLabel')}</div>
                <div className="mt-2 text-sm font-medium text-[color:var(--operator-foreground)]">{preflight ? new Date(preflight.checked_at).toLocaleString() : t('deployPreflightNotRun')}</div>
              </div>
            </div>

            {preflight ? (
              preflight.ok ? (
                <div className="mt-4 rounded-2xl border border-emerald-400/18 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-100">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                    <div className="space-y-1">
                      <p>{t('deployPreflightReadyBody')}</p>
                      <p className="text-xs text-emerald-200">{t('deployPreflightMcpOk', { count: preflight.mcp_validation_errors.length })}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 space-y-3 rounded-2xl border border-amber-400/16 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div className="space-y-3">
                      <p>{t('deployPreflightBlockedBody')}</p>
                      <ul className="list-disc space-y-1 pl-4">
                        {preflight.blocking_reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                      {preflight.mcp_validation_errors.length > 0 ? (
                        <div>
                          <p className="font-medium text-amber-50">{t('deployPreflightMcpErrorsTitle')}</p>
                          <ul className="mt-2 list-disc space-y-1 pl-4">
                            {preflight.mcp_validation_errors.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-white/12 bg-white/4 px-4 py-4 text-sm text-[color:var(--operator-muted)]">
                {t('deployPreflightPendingBody')}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="glass" size="lg" disabled={preflightRunning || deploying || !deploymentPayload} onClick={() => void handleRunPreflight()}>
                {preflightRunning ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}
                {preflight ? t('deployPreflightRerunCta') : t('deployPreflightRunCta')}
              </Button>
              <Link href="/dashboard/settings" className={buttonVariants({ variant: 'glass', size: 'lg' })}>{t('deployPreflightSettingsCta')}</Link>
            </div>
          </GlassPanel>

          {deploying ? (
            <div className="rounded-2xl border border-[color:var(--operator-primary)]/18 bg-[color:var(--operator-primary)]/10 px-4 py-4 text-sm text-[color:var(--operator-primary-soft)]">
              <div className="flex items-center gap-3">
                <Loader2 className="size-4 animate-spin" />
                <span>{deploymentStatus === 'ACTIVE' ? t('deploySuccessToastBody', { name: deploymentName }) : t('deployingBody', { status: deploymentStatus ?? 'DEPLOYING' })}</span>
              </div>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <AgentDeploymentVerificationStep
        deploymentName={completedDeployment?.name ?? deploymentName}
        deploymentStatus={completedDeployment?.status ?? deploymentStatus ?? 'ACTIVE'}
        lastDeployedAt={completedDeployment?.last_deployed_at ?? null}
        verification={completedDeployment?.config?.verification ?? null}
        verificationScopeSummary={verificationScopeSummary}
        deploymentProviderLabel={deploymentProviderLabel}
        model={completedDeployment?.model ?? model}
        autoRoutingPreviewLabel={autoRoutingPreviewLabel}
        autoRoutingRuleCount={autoRoutingPreview.rules.length}
        mcpValidationErrorCount={preflight ? preflight.mcp_validation_errors.length : null}
        verificationSubmitting={verificationSubmitting}
        onCompleteVerification={() => void handleCompleteVerification()}
      />
    );
  };

  return (
    <>
      <div className="space-y-4 pb-28 lg:pb-0">
        <PageHeader
          eyebrow={t('eyebrow')}
          title={t('deployTitle')}
          description={t('deployDescription', { project: currentProjectName ?? t('unknownProject') })}
          actions={<Badge variant="chip">{agent ? t('agentBadge', { name: agent.name }) : t('agentUnavailableBadge')}</Badge>}
        />

        <SectionCard>
          <SectionCardHeader>
            <div className="grid gap-3 md:grid-cols-5">
              {STEP_KEYS.map((key, index) => {
                const Icon = STEP_ICONS[index];
                const active = index === step;
                const complete = index < step;
                return (
                  <div key={key} className={`rounded-3xl border px-4 py-3 transition ${active ? 'border-[color:var(--operator-primary)]/45 bg-[color:var(--operator-primary)]/12' : complete ? 'border-emerald-400/20 bg-emerald-400/10' : 'border-white/8 bg-white/4'}`}>
                    <div className="flex items-center gap-3">
                      <div className={`flex size-9 items-center justify-center rounded-2xl ${active ? 'bg-[color:var(--operator-primary)]/20 text-[color:var(--operator-primary-soft)]' : complete ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/8 text-[color:var(--operator-muted)]'}`}>
                        {complete ? <CheckCircle2 className="size-4" /> : <Icon className="size-4" />}
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t(`steps.${key}.eyebrow`)}</div>
                        <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t(`steps.${key}.title`)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-5">
            {renderStep()}
          </SectionCardBody>
        </SectionCard>
      </div>

      {step < STEP_KEYS.length - 1 ? (
        <div className="fixed inset-x-3 bottom-6 z-40 lg:static lg:inset-auto lg:z-auto">
          <GlassPanel className="border-white/12 bg-[color:var(--operator-panel)]/92 p-3 shadow-[0_24px_60px_rgba(0,0,0,0.42)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-[color:var(--operator-muted)]">
                {t('stepProgress', { step: step + 1, total: STEP_KEYS.length })}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="glass" size="lg" disabled={step === 0 || deploying || preflightRunning} onClick={() => setStep((current) => Math.max(0, current - 1))}>
                  <ChevronLeft className="mr-2 size-4" />
                  {tc('back')}
                </Button>
                {step < STEP_KEYS.length - 2 ? (
                  <Button variant="hero" size="lg" disabled={!canAdvance || deploying || preflightRunning} onClick={() => setStep((current) => Math.min(STEP_KEYS.length - 1, current + 1))}>
                    {tc('next')}
                    <ChevronRight className="ml-2 size-4" />
                  </Button>
                ) : (
                  <>
                    <Button variant="glass" size="lg" disabled={deploying || preflightRunning || !deploymentPayload} onClick={() => void handleRunPreflight()}>
                      {preflightRunning ? <Loader2 className="mr-2 size-4 animate-spin" /> : <CheckCircle2 className="mr-2 size-4" />}
                      {preflight ? t('deployPreflightRerunCta') : t('deployPreflightRunCta')}
                    </Button>
                    <Button
                      variant="hero"
                      size="lg"
                      disabled={!canAdvance || deploying || preflightRunning || !canDeploy || !deploymentPayload || (autoRoutingPreview.requiresOverwriteConfirmation && !overwriteRoutingRules)}
                      onClick={() => void handleDeploy()}
                    >
                      {deploying ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Rocket className="mr-2 size-4" />}
                      {t('deployCta')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </GlassPanel>
        </div>
      ) : null}

      <Dialog open={Boolean(failureMessage)} onOpenChange={(open) => { if (!open) setFailureMessage(null); }}>
        <DialogContent className="max-w-lg rounded-3xl border border-white/10 bg-[color:var(--operator-panel)] text-[color:var(--operator-foreground)] shadow-[0_30px_80px_rgba(0,0,0,0.42)]">
          <DialogHeader>
            <DialogTitle>{t('deployFailedTitle')}</DialogTitle>
            <DialogDescription className="text-[color:var(--operator-muted)]">{failureMessage ?? t('deployFailedBody')}</DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl border border-amber-400/16 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('deployFailedHint')}</p>
            </div>
          </div>
          <DialogFooter className="border-t border-white/8 bg-transparent">
            <Button variant="glass" onClick={() => setFailureMessage(null)}>{tc('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
