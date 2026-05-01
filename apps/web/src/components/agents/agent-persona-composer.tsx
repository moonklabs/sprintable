'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PersonaChangeHistoryEntry, PersonaPermissionBoundary, PersonaVersionMetadata } from '@/lib/persona-governance-contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { OperatorInput, OperatorSelect, OperatorTextarea } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import type { PersonaToolOption } from '@/services/persona-composer';
import { estimatePromptTokens } from '@/services/persona-composer';
import { createBrowserClient } from '@/lib/db/client';

export interface PersonaComposerAgent {
  id: string;
  name: string;
}

export interface PersonaComposerPersona {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  resolved_system_prompt: string;
  resolved_style_prompt: string | null;
  tool_allowlist: string[];
  version_metadata: PersonaVersionMetadata;
  permission_boundary: PersonaPermissionBoundary;
  change_history: PersonaChangeHistoryEntry[];
  is_builtin: boolean;
  is_default: boolean;
}

interface CreatedPersona {
  id: string;
  name: string;
  slug: string;
}

function getDefaultBasePersonaId(personas: PersonaComposerPersona[]) {
  return personas.find((persona) => persona.is_default)?.id ?? personas[0]?.id ?? '';
}

function groupToolOptions(options: PersonaToolOption[]) {
  return options.reduce<Record<string, PersonaToolOption[]>>((groups, option) => {
    const groupId = option.groupKind === 'mcp'
      ? `mcp:${option.serverName ?? 'default'}`
      : option.groupKind;
    groups[groupId] = [...(groups[groupId] ?? []), option];
    return groups;
  }, {});
}

function getToolGroupLabel(t: ReturnType<typeof useTranslations>, groupId: string, option: PersonaToolOption | undefined) {
  if (!option) return groupId;
  if (option.groupKind === 'builtin') return t('personaComposerBuiltInGroupTitle');
  if (option.groupKind === 'github') return t('personaComposerGitHubGroupTitle');
  return t('personaComposerMcpGroupTitle', { name: option.serverName ?? t('personaComposerMcpGroupFallbackName') });
}

function formatPersonaTimestamp(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AgentPersonaComposer({
  agents,
  personasByAgentId,
  toolOptions,
  safetyLayerNotice,
}: {
  agents: PersonaComposerAgent[];
  personasByAgentId: Record<string, PersonaComposerPersona[]>;
  toolOptions: PersonaToolOption[];
  safetyLayerNotice: string;
}) {
  const t = useTranslations('agents');
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? '');
  const [selectedBasePersonaId, setSelectedBasePersonaId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [behaviorRules, setBehaviorRules] = useState('');
  const [customizeTools, setCustomizeTools] = useState(false);
  const [selectedToolNames, setSelectedToolNames] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdPersona, setCreatedPersona] = useState<CreatedPersona | null>(null);

  const personas = useMemo(() => personasByAgentId[selectedAgentId] ?? [], [personasByAgentId, selectedAgentId]);
  const basePersona = personas.find((persona) => persona.id === selectedBasePersonaId) ?? null;
  const groupedToolOptions = useMemo(() => groupToolOptions(toolOptions), [toolOptions]);
  const mcpToolCount = toolOptions.filter((option) => option.source === 'mcp').length;

  useEffect(() => {
    if (!personas.length) {
      setSelectedBasePersonaId('');
      return;
    }

    setSelectedBasePersonaId((current) => (
      personas.some((persona) => persona.id === current) ? current : getDefaultBasePersonaId(personas)
    ));
  }, [personas]);

  const effectiveToolNames = customizeTools
    ? selectedToolNames
    : (basePersona?.tool_allowlist ?? []);

  const resolvedSystemPrompt = [basePersona?.resolved_system_prompt, systemPrompt.trim()].filter(Boolean).join('\n\n');
  const resolvedBehaviorRules = [basePersona?.resolved_style_prompt, behaviorRules.trim()].filter(Boolean).join('\n\n');
  const runtimePromptPreview = [resolvedSystemPrompt, resolvedBehaviorRules, safetyLayerNotice].filter(Boolean).join('\n\n');

  const tokenStats = [
    { label: t('personaComposerTokensBase'), value: estimatePromptTokens(basePersona?.resolved_system_prompt ?? '') },
    { label: t('personaComposerTokensCustom'), value: estimatePromptTokens([systemPrompt.trim(), behaviorRules.trim()].filter(Boolean).join('\n\n')) },
    { label: t('personaComposerTokensSafety'), value: estimatePromptTokens(safetyLayerNotice) },
    { label: t('personaComposerTokensTotal'), value: estimatePromptTokens(runtimePromptPreview) },
  ];

  const handleToggleTool = (toolName: string) => {
    setSelectedToolNames((current) => (
      current.includes(toolName)
        ? current.filter((entry) => entry !== toolName)
        : [...current, toolName]
    ));
  };

  const handleCustomizeToolsChange = (nextValue: boolean) => {
    setCustomizeTools(nextValue);
    if (nextValue && selectedToolNames.length === 0) {
      setSelectedToolNames(basePersona?.tool_allowlist ?? []);
    }
  };

  const handleCreatePersona = async () => {
    if (!selectedAgentId || !selectedBasePersonaId || !name.trim()) return;

    setSubmitting(true);
    setErrorMessage(null);
    setCreatedPersona(null);

    try {
      const db = createBrowserClient();
      const { data: { session } } = await db.auth.getSession();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
      const response = await fetch('/api/v2/agent-personas', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agent_id: selectedAgentId,
          name: name.trim(),
          description: description.trim() || null,
          base_persona_id: selectedBasePersonaId,
          system_prompt: systemPrompt.trim(),
          style_prompt: behaviorRules.trim() || null,
          tool_allowlist: customizeTools ? selectedToolNames : undefined,
        }),
      });

      const payload = await response.json().catch(() => null) as {
        data?: CreatedPersona;
        error?: { message?: string; issues?: Array<{ message: string }> };
      } | null;

      if (!response.ok || !payload?.data) {
        const validationMessage = payload?.error?.issues?.[0]?.message;
        throw new Error(validationMessage ?? payload?.error?.message ?? t('personaComposerCreateError'));
      }

      setCreatedPersona(payload.data);
      setName('');
      setDescription('');
      setSystemPrompt('');
      setBehaviorRules('');
      setCustomizeTools(false);
      setSelectedToolNames([]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('personaComposerCreateError'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!agents.length) {
    return (
      <EmptyState
        title={t('personaComposerNoAgentsTitle')}
        description={t('personaComposerNoAgentsDescription')}
        action={<Link href="/agents/deploy" className="text-sm text-primary underline-offset-4 hover:underline">{t('backToWizard')}</Link>}
      />
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.9fr)]">
      <div className="space-y-4">
        <SectionCard>
          <SectionCardHeader>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">{t('personaComposerSectionTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('personaComposerSectionBody')}</p>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="font-medium text-foreground">{t('personaComposerAgentLabel')}</span>
                <OperatorSelect value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </OperatorSelect>
              </label>
              <label className="space-y-2 text-sm">
                <span className="font-medium text-foreground">{t('personaComposerBaseLabel')}</span>
                <OperatorSelect value={selectedBasePersonaId} onChange={(event) => setSelectedBasePersonaId(event.target.value)}>
                  <optgroup label={t('builtInPersonas')}>
                    {personas.filter((persona) => persona.is_builtin).map((persona) => (
                      <option key={persona.id} value={persona.id}>{persona.name}{persona.is_default ? ` · ${t('personaComposerDefaultSuffix')}` : ''}</option>
                    ))}
                  </optgroup>
                  <optgroup label={t('customPersonas')}>
                    {personas.filter((persona) => !persona.is_builtin).map((persona) => (
                      <option key={persona.id} value={persona.id}>{persona.name}{persona.is_default ? ` · ${t('personaComposerDefaultSuffix')}` : ''}</option>
                    ))}
                  </optgroup>
                </OperatorSelect>
              </label>
            </div>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-foreground">{t('personaComposerNameLabel')}</span>
              <OperatorInput value={name} onChange={(event) => setName(event.target.value)} placeholder={t('personaComposerNamePlaceholder')} />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-foreground">{t('personaComposerDescriptionLabel')}</span>
              <OperatorTextarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('personaComposerDescriptionPlaceholder')} className="min-h-[88px]" />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-foreground">{t('personaComposerSystemPromptLabel')}</span>
              <OperatorTextarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder={t('personaComposerSystemPromptPlaceholder')} className="min-h-[180px]" />
            </label>

            <label className="space-y-2 text-sm">
              <span className="font-medium text-foreground">{t('personaComposerBehaviorRulesLabel')}</span>
              <OperatorTextarea value={behaviorRules} onChange={(event) => setBehaviorRules(event.target.value)} placeholder={t('personaComposerBehaviorRulesPlaceholder')} className="min-h-[140px]" />
            </label>
          </SectionCardBody>
        </SectionCard>

        <SectionCard>
          <SectionCardHeader>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">{t('personaComposerToolsTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('personaComposerToolsBody')}</p>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => handleCustomizeToolsChange(false)} className={`rounded-full border px-3 py-1 text-sm ${!customizeTools ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/30 text-muted-foreground'}`}>
                {t('personaComposerToolsInherit')}
              </button>
              <button type="button" onClick={() => handleCustomizeToolsChange(true)} className={`rounded-full border px-3 py-1 text-sm ${customizeTools ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/30 text-muted-foreground'}`}>
                {t('personaComposerToolsCustom')}
              </button>
            </div>

            {!customizeTools ? (
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-sm text-muted-foreground">{t('personaComposerToolsInheritedHelp')}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {effectiveToolNames.length > 0 ? effectiveToolNames.map((toolName) => (
                    <Badge key={toolName} variant="chip">{toolName}</Badge>
                  )) : <p className="text-sm text-muted-foreground">{t('personaComposerToolsEmpty')}</p>}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {Object.entries(groupedToolOptions).map(([groupId, options]) => (
                  <div key={groupId} className="space-y-2 rounded-md border border-border bg-muted/30 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">{getToolGroupLabel(t, groupId, options[0])}</h3>
                        <p className="text-xs text-muted-foreground">{options[0]?.source === 'mcp' ? t('personaComposerMcpGroupHint') : t('personaComposerBuiltInGroupHint')}</p>
                      </div>
                      <Badge variant={options[0]?.source === 'mcp' ? 'info' : 'outline'}>{options.length}</Badge>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {options.map((option) => {
                        const checked = selectedToolNames.includes(option.name);
                        return (
                          <label key={option.name} className={`flex items-start gap-3 rounded-md border px-3 py-3 text-sm ${checked ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30'}`}>
                            <input type="checkbox" checked={checked} onChange={() => handleToggleTool(option.name)} className="mt-1 h-4 w-4 accent-[color:var(--operator-primary)]" />
                            <span className="space-y-1">
                              <span className="block font-medium text-foreground">{option.name}</span>
                              <span className="block text-xs text-muted-foreground">{option.source === 'mcp' ? t('personaComposerMcpToolHint') : t('personaComposerBuiltInToolHint')}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {mcpToolCount === 0 ? <p className="text-sm text-muted-foreground">{t('personaComposerNoMcpTools')}</p> : null}
              </div>
            )}
          </SectionCardBody>
        </SectionCard>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-4 shadow-sm">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{t('personaComposerSubmitTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('personaComposerSubmitBody')}</p>
          </div>
          <Button variant="hero" size="lg" disabled={submitting || !name.trim() || !selectedAgentId || !selectedBasePersonaId} onClick={handleCreatePersona}>
            {submitting ? t('personaComposerSubmitting') : t('personaComposerSubmit')}
          </Button>
        </div>

        {errorMessage ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        {createdPersona ? (
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-4 py-4 text-sm text-emerald-600 dark:text-emerald-400">
            <p className="font-semibold">{t('personaComposerSuccessTitle', { name: createdPersona.name })}</p>
            <p className="mt-1 text-emerald-200/90">{t('personaComposerSuccessBody', { slug: createdPersona.slug })}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Link href="/agents/deploy" className="text-sm font-medium underline-offset-4 hover:underline">{t('backToWizard')}</Link>
              <button type="button" onClick={() => setCreatedPersona(null)} className="text-sm font-medium underline-offset-4 hover:underline">{t('personaComposerCreateAnother')}</button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-4">
        <SectionCard>
          <SectionCardHeader>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">{t('personaComposerPreviewTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('personaComposerPreviewBody')}</p>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-foreground">{basePersona?.name ?? t('personaComposerBaseMissing')}</p>
                {basePersona?.is_builtin ? <Badge variant="success">{t('builtInPersonas')}</Badge> : <Badge variant="chip">{t('customPersonas')}</Badge>}
                {basePersona?.is_default ? <Badge variant="info">{t('personaComposerDefaultSuffix')}</Badge> : null}
              </div>
              {basePersona?.description ? <p className="mt-2 text-sm text-muted-foreground">{basePersona.description}</p> : null}
            </div>

            {basePersona ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-border bg-muted/30 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{t('personaComposerVersionLabel')}</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">v{basePersona.version_metadata.version_number}</p>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{t('personaComposerPublishedAtLabel')}</p>
                  <p className="mt-2 text-sm font-medium text-foreground">{formatPersonaTimestamp(basePersona.version_metadata.published_at)}</p>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{t('personaComposerRollbackLabel')}</p>
                  <p className="mt-2 text-sm font-medium text-foreground">{basePersona.version_metadata.rollback_target_version_number != null ? `v${basePersona.version_metadata.rollback_target_version_number}` : t('personaComposerRollbackEmpty')}</p>
                </div>
              </div>
            ) : null}

            {basePersona ? (
              <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">{t('personaComposerBoundaryTitle')}</p>
                  <p className="text-sm text-muted-foreground">{t('personaComposerBoundaryBody')}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{t('personaComposerBoundaryToolsLabel')}</p>
                  <div className="flex flex-wrap gap-2">
                    {basePersona.permission_boundary.allowed_tool_names.length > 0 ? basePersona.permission_boundary.allowed_tool_names.map((toolName) => (
                      <Badge key={toolName} variant="chip">{toolName}</Badge>
                    )) : <p className="text-sm text-muted-foreground">{t('personaComposerToolsEmpty')}</p>}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{t('personaComposerBoundaryServersLabel')}</p>
                  <div className="flex flex-wrap gap-2">
                    {basePersona.permission_boundary.mcp_server_names.length > 0 ? basePersona.permission_boundary.mcp_server_names.map((serverName) => (
                      <Badge key={serverName} variant="outline">{serverName}</Badge>
                    )) : <p className="text-sm text-muted-foreground">{t('personaComposerBoundaryServersEmpty')}</p>}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{t('personaComposerBoundaryLayersLabel')}</p>
                  <div className="flex flex-wrap gap-2">
                    {basePersona.permission_boundary.enforcement_layers.map((layer) => (
                      <Badge key={layer} variant="info">{layer}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              {tokenStats.map((stat) => (
                <div key={stat.label} className="rounded-md border border-border bg-muted/30 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{stat.label}</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{stat.value}</p>
                </div>
              ))}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('personaComposerSafetyLabel')}</p>
              <OperatorTextarea readOnly value={safetyLayerNotice} className="min-h-[112px] opacity-80" />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('personaComposerResolvedPromptLabel')}</p>
              <OperatorTextarea readOnly value={runtimePromptPreview || t('personaComposerResolvedPromptEmpty')} className="min-h-[280px] opacity-80" />
            </div>

            {basePersona ? (
              <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">{t('personaComposerHistoryTitle')}</p>
                  <p className="text-sm text-muted-foreground">{t('personaComposerHistoryBody')}</p>
                </div>
                {basePersona.change_history.length > 0 ? (
                  <div className="space-y-2">
                    {basePersona.change_history.map((entry) => (
                      <div key={`${entry.event_type}-${entry.created_at}`} className="rounded-md border border-border bg-muted/30 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{entry.summary}</p>
                          {entry.version_number != null ? <Badge variant="outline">{t('personaComposerHistoryVersion', { version: entry.version_number })}</Badge> : null}
                          {entry.rollback_target_version_number != null ? <Badge variant="chip">{t('personaComposerHistoryRollback', { version: entry.rollback_target_version_number })}</Badge> : null}
                        </div>
                        {entry.change_summary ? <p className="mt-1 text-sm text-muted-foreground">{entry.change_summary}</p> : null}
                        <p className="mt-2 text-xs text-muted-foreground">{formatPersonaTimestamp(entry.created_at)}</p>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-muted-foreground">{t('personaComposerHistoryEmpty')}</p>}
              </div>
            ) : null}
          </SectionCardBody>
        </SectionCard>
      </div>
    </div>
  );
}
