'use client';

import { useEffect, useState } from 'react';
import type { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { cyclicStages, type EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { RecipeRoleMappingFields } from '@/components/organization/recipe-role-mapping-fields';
import type { useToast } from '@/components/ui/toast';

interface AgentOption {
  id: string;
  name: string;
}

// story #3316 — organization/events 카탈로그에 빠져 있던 "프로젝트에 적용" 진입점. gallery
// (workflow-template-gallery-section.tsx, 프로젝트 설정 화면)는 이미 프로젝트 컨텍스트 안이라
// projectId를 props로 받지만, 이 다이얼로그는 org 레벨 카탈로그에서 열리므로 프로젝트 자체를
// 먼저 골라야 한다 — 그 한 가지 차이 말고는 role_mapping 입력/적용/warnings 렌더 전부 gallery와
// 동일 계약(POST .../apply body {project_id, role_mapping} 그대로 재사용, 신규 엔드포인트 없음).
export function ApplyRecipeDialog({
  target, open, onOpenChange, t, tc, addToast,
}: {
  target: (EventDefinitionResponse & { id: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [roleMapping, setRoleMapping] = useState<Record<string, string>>({});
  const [loadingProjectData, setLoadingProjectData] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setProjectId('');
    setAgents([]);
    setRoleMapping({});
    setError(null);
    setWarnings([]);
    void (async () => {
      const res = await fetchWithAuth('/api/projects');
      if (!res.ok) return;
      const json = await res.json() as { data?: { id: string; name: string }[] };
      setProjects((json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    })();
  }, [open]);

  useEffect(() => {
    if (!projectId || !target) { setAgents([]); setRoleMapping({}); return; }
    setLoadingProjectData(true);
    setError(null);
    setWarnings([]);
    void (async () => {
      try {
        const [memberRes, bindingsRes] = await Promise.all([
          fetchWithAuth(`/api/team-members?project_id=${projectId}&type=agent`),
          fetchWithAuth(`/api/events/definitions/${target.id}/bindings?project_id=${projectId}`),
        ]);
        if (memberRes.ok) {
          const json = await memberRes.json() as { data?: AgentOption[] } | AgentOption[];
          setAgents(Array.isArray(json) ? json : (json.data ?? []));
        } else {
          setAgents([]);
        }
        if (bindingsRes.ok) {
          const j = await bindingsRes.json() as { bindings?: Record<string, string> };
          setRoleMapping(j.bindings ?? {});
        } else {
          setRoleMapping({});
        }
      } finally {
        setLoadingProjectData(false);
      }
    })();
  }, [projectId, target]);

  if (!target) return null;
  const stages = cyclicStages(target);

  const submit = async () => {
    if (!projectId) return;
    const missing = stages.filter((s) => !roleMapping[s]);
    if (missing.length > 0) {
      setError(t('eventApplyMissingRoles', { stages: missing.join(', ') }));
      return;
    }
    setApplying(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetchWithAuth(`/api/events/definitions/${target.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, role_mapping: roleMapping }),
      });
      const data = await res.json() as {
        ok?: boolean; bindings_upserted?: number; warnings?: string[]; error?: { message?: string };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message ?? t('eventApplyErrorGeneric'));
      }
      if ((data.warnings ?? []).length > 0) {
        setWarnings(data.warnings ?? []);
      } else {
        addToast({ type: 'success', title: t('eventApplySuccessToast', { count: data.bindings_upserted ?? 0 }) });
        onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('eventApplyErrorGeneric'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!applying) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('eventApplyDialogTitle', { name: target.name || target.key })}</DialogTitle>
          <DialogDescription>{t('eventApplyRoleMappingHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="apply-recipe-project" className="text-xs font-medium text-muted-foreground">
            {t('eventApplyProjectLabel')}
          </label>
          <select
            id="apply-recipe-project"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('eventApplyProjectPlaceholder')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {!projectId ? (
          <p className="text-xs text-muted-foreground">{t('eventApplySelectProjectHint')}</p>
        ) : loadingProjectData ? (
          <p className="text-xs text-muted-foreground">{t('eventApplyLoadingBindings')}</p>
        ) : (
          <div className="space-y-2.5">
            <RecipeRoleMappingFields
              stages={stages}
              stageMetadata={target.stage_metadata}
              agents={agents}
              roleMapping={roleMapping}
              onChange={(stage, agentId) => setRoleMapping((prev) => ({ ...prev, [stage]: agentId }))}
              agentPlaceholder={t('eventApplyAgentPlaceholder')}
            />
          </div>
        )}

        {warnings.length > 0 ? (
          <div className="space-y-1 rounded-md border border-warning-border bg-warning-tint p-2 text-xs text-foreground">
            <p className="font-medium text-warning-strong">{t('eventApplyWarningsHeading')}</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        ) : null}

        {error ? (
          <p role="alert" aria-live="assertive" className="rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>{tc('cancel')}</Button>
          <Button
            onClick={() => void submit()}
            disabled={applying || !projectId || loadingProjectData || stages.some((s) => !roleMapping[s])}
          >
            {applying ? t('eventApplySubmitting') : t('eventApplySubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
