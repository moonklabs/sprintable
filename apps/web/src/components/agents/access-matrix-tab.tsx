'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2 } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

interface OrgAgent {
  id: string;
  name: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface AccessMatrixRow {
  agent_member_id: string;
  project_id: string;
  record_id: string;
}

/**
 * story da4c6b2d — org 전체 에이전트(행) × 프로젝트(열) 접근권한 매트릭스.
 * 데이터 = `agent-project-access-section.tsx`(상세 per-agent 토글)와 동일 원천
 * (`project_access`)의 다른 pivot. bulk 시드는 `GET /api/agents/access-matrix`(PR #1948,
 * org 단위 단일 쿼리 — Phase 1 관리탭 요약과 달리 admin/owner 게이트가 전체 매트릭스 단위라
 * 개별 셀 403은 발생하지 않는다. 일시 오류(네트워크/500)만 매트릭스 전체 재시도로 처리).
 * grant/revoke 쓰기는 기존 v1 엔드포인트 그대로 재사용 — 신규 API 없음.
 */
export function AccessMatrixTab() {
  const t = useTranslations('settings');
  const ta = useTranslations('agents');

  const [agents, setAgents] = useState<OrgAgent[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  // (agent_member_id, project_id) → record_id. 없으면 차단.
  const [grantMap, setGrantMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const key = (agentId: string, projectId: string) => `${agentId}::${projectId}`;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [agentsRes, projectsRes, matrixRes] = await Promise.all([
        fetch('/api/team-members?type=agent&include_inactive=true'),
        fetch('/api/projects'),
        fetch('/api/agents/access-matrix'),
      ]);
      if (!agentsRes.ok || !projectsRes.ok || !matrixRes.ok) { setLoadError(true); return; }
      const agentsJson = await agentsRes.json() as { data?: OrgAgent[] };
      const projectsJson = await projectsRes.json() as { data?: ProjectOption[] };
      const matrixJson = await matrixRes.json() as { data?: AccessMatrixRow[] };

      setAgents(agentsJson.data ?? []);
      setProjects((projectsJson.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));

      const map: Record<string, string> = {};
      for (const row of matrixJson.data ?? []) {
        map[key(row.agent_member_id, row.project_id)] = row.record_id;
      }
      setGrantMap(map);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (agentId: string, project: ProjectOption) => {
    const k = key(agentId, project.id);
    if (togglingKey) return;
    setTogglingKey(k);
    setMessage(null);
    const recordId = grantMap[k];
    try {
      if (recordId) {
        const res = await fetch(`/api/projects/${project.id}/access/${recordId}`, { method: 'DELETE' });
        if (res.ok) {
          setGrantMap((m) => { const n = { ...m }; delete n[k]; return n; });
        } else {
          setMessage({ type: 'error', text: t('agentActionFailed') });
        }
      } else {
        const res = await fetch(`/api/projects/${project.id}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: agentId, org_member_id: null, permission: 'granted' }),
        });
        if (res.ok) {
          let recId = (await res.json().catch(() => null) as { data?: { id?: string } } | null)?.data?.id;
          if (!recId) {
            const g = await fetch(`/api/agents/access-matrix`).catch(() => null);
            if (g?.ok) {
              const j = await g.json() as { data?: AccessMatrixRow[] };
              recId = (j.data ?? []).find((r) => r.agent_member_id === agentId && r.project_id === project.id)?.record_id;
            }
          }
          if (recId) setGrantMap((m) => ({ ...m, [k]: recId! }));
        } else {
          setMessage({ type: 'error', text: t('agentActionFailed') });
        }
      }
    } finally {
      setTogglingKey(null);
    }
  };

  const grantedCount = Object.keys(grantMap).length;
  const totalCells = agents.length * projects.length;

  if (loading) {
    return (
      <div className="p-6">
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-6">
        <SectionCard>
          <SectionCardBody>
            <p className="text-sm text-muted-foreground">{ta('matrixLoadError')}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
            >
              {ta('matrixRetry')}
            </button>
          </SectionCardBody>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="p-6">
      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">{ta('matrixTitle')}</h2>
              <p className="text-sm text-muted-foreground">{ta('matrixDescription')}</p>
            </div>
            {totalCells > 0 ? (
              <div className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                <div className="font-medium text-foreground">{grantedCount} / {totalCells}</div>
                <div>{ta('matrixGrantedCount')}</div>
              </div>
            ) : null}
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {message ? <p className="mb-3 text-xs text-destructive">{message.text}</p> : null}

          {agents.length === 0 || projects.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center">
              <p className="text-sm text-muted-foreground">{ta('matrixEmpty')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="sticky left-0 z-10 bg-muted/30 px-3 py-2 text-left font-medium text-foreground">
                      {ta('matrixAgentColumn')}
                    </th>
                    {projects.map((project) => (
                      <th key={project.id} className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground">
                        {project.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr key={agent.id} className="border-b border-border last:border-b-0">
                      <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium text-foreground">
                        {agent.name}
                      </td>
                      {projects.map((project) => {
                        const k = key(agent.id, project.id);
                        const granted = k in grantMap;
                        const toggling = togglingKey === k;
                        return (
                          <td key={project.id} className="px-3 py-2 text-center">
                            <button
                              type="button"
                              disabled={toggling}
                              onClick={() => void handleToggle(agent.id, project)}
                              className={cn(
                                'inline-flex size-7 items-center justify-center rounded-md border transition-colors',
                                granted
                                  ? 'border-success/40 bg-success-tint text-success hover:bg-success/15'
                                  : 'border-border text-muted-foreground hover:bg-muted/40',
                              )}
                              aria-label={granted ? ta('matrixCellGranted') : ta('matrixCellBlocked')}
                            >
                              {toggling ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : granted ? (
                                <Check className="size-3.5" />
                              ) : null}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex size-4 items-center justify-center rounded border border-success/40 bg-success-tint text-success">
                <Check className="size-2.5" />
              </span>
              {ta('matrixLegendGranted')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-4 rounded border border-border" />
              {ta('matrixLegendBlocked')}
            </span>
            <span className="ml-auto">{ta('matrixAdminOnlyHint')}</span>
          </div>
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
