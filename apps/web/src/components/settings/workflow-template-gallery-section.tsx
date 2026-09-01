'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import { cyclicStages, isCyclicDefinition, type EventDefinitionResponse } from '@/components/loops/loop-create-dialog';

// story #3293(도메인탈고정 축2-ⓒ) — 구세대 workflow_templates(story #3010 P3 등) 소비를
// 신세대(EventDefinition/recipe_role_bindings, 축2-ⓐ story #3288)로 이전. doc
// axis2c-gallery-migration-map-and-design §2/§3 매핑+PO 확定(A/B/C) 그대로:
// - A: overwrite 확認 다이얼로그 대신 기존 배정값을 드롭다운에 프리필(§B read로 조회).
// - B: 신규 GET .../bindings 로 "적용됨" 판정+프리필(구세대 agent-routing-rules 스캔 대체).
// - C: presets(역할명 프리셋) 드롭다운은 스킵 — 저장 로직 무영향, 순수 FE 편의였음.

interface TeamMember {
  id: string;
  name: string;
  type: string;
  role?: string;
}

function StageCountBadge({ count }: { count: number }) {
  const labels: Record<number, string> = { 0: 'Kanban', 1: '1-step', 2: '2-step', 3: '3-step' };
  return (
    <Badge variant="secondary" className="text-[10px]">
      {labels[count] ?? `${count}-step`}
    </Badge>
  );
}

export function WorkflowTemplateGallerySection({
  projectId,
  orgId: _orgId,
}: {
  projectId: string;
  orgId?: string;
}) {
  const _t = useTranslations('settings');

  const [definitions, setDefinitions] = useState<EventDefinitionResponse[]>([]);
  const [agents, setAgents] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<EventDefinitionResponse | null>(null);
  const [loadingBindings, setLoadingBindings] = useState(false);
  const [appliedKeys, setAppliedKeys] = useState<Set<string>>(new Set());

  const [roleMapping, setRoleMapping] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; message: string } | null>(null);

  const cyclicDefinitions = definitions.filter(isCyclicDefinition);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [defRes, memberRes] = await Promise.all([
        fetchWithAuth('/api/events/definitions'),
        fetchWithAuth(`/api/team-members?project_id=${projectId}&type=agent`),
      ]);
      if (defRes.ok) {
        const data: unknown = await defRes.json();
        const defs = Array.isArray(data) ? (data as EventDefinitionResponse[]) : [];
        setDefinitions(defs);
        // "적용됨" 배지 — cyclic 정의마다 이 project에 바인딩이 하나라도 있는지 조회.
        const cyclic = defs.filter(isCyclicDefinition);
        const applied = new Set<string>();
        await Promise.all(cyclic.map(async d => {
          const r = await fetchWithAuth(`/api/events/definitions/${d.id}/bindings?project_id=${projectId}`);
          if (r.ok) {
            const j = await r.json() as { bindings?: Record<string, string> };
            if (Object.keys(j.bindings ?? {}).length > 0) applied.add(d.key);
          }
        }));
        setAppliedKeys(applied);
      }
      if (memberRes.ok) {
        const json = await memberRes.json() as { data?: TeamMember[] } | TeamMember[];
        const members = Array.isArray(json) ? json : ((json as { data?: TeamMember[] }).data ?? []);
        setAgents(members);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadData(); }, [loadData]);

  const handleSelectDefinition = async (def: EventDefinitionResponse) => {
    setSelected(def);
    setApplyResult(null);
    setLoadingBindings(true);
    try {
      // PO 확定 A — 기존 배정값을 프리필해 "뭘 덮어쓰는지" 보이게(확認 다이얼로그 대체).
      const res = await fetchWithAuth(`/api/events/definitions/${def.id}/bindings?project_id=${projectId}`);
      if (res.ok) {
        const j = await res.json() as { bindings?: Record<string, string> };
        setRoleMapping(j.bindings ?? {});
      } else {
        setRoleMapping({});
      }
    } finally {
      setLoadingBindings(false);
    }
  };

  const requiredStages = selected ? cyclicStages(selected) : [];

  const handleApply = async () => {
    if (!selected) return;

    const missing = requiredStages.filter(stage => !roleMapping[stage]);
    if (missing.length > 0) {
      setApplyResult({ ok: false, message: `역할 매핑 필요: ${missing.join(', ')}` });
      return;
    }

    setApplying(true);
    setApplyResult(null);
    try {
      const res = await fetchWithAuth(`/api/events/definitions/${selected.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, role_mapping: roleMapping }),
      });
      const data = await res.json() as { ok?: boolean; bindings_upserted?: number; error?: { message?: string } };
      if (res.ok && data.ok) {
        setApplyResult({ ok: true, message: `배정 ${String(data.bindings_upserted ?? 0)}건 저장 완료` });
        setAppliedKeys(prev => new Set(prev).add(selected.key));
      } else {
        setApplyResult({ ok: false, message: data.error?.message ?? '적용 실패' });
      }
    } catch {
      setApplyResult({ ok: false, message: '네트워크 오류' });
    } finally {
      setApplying(false);
    }
  };

  if (loading) {
    return (
      <SectionCard>
        <SectionCardHeader>
          <h2 className="text-base font-semibold text-foreground">워크플로우 템플릿 갤러리</h2>
        </SectionCardHeader>
        <SectionCardBody>
          <p className="text-sm text-muted-foreground">로딩 중...</p>
        </SectionCardBody>
      </SectionCard>
    );
  }

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">워크플로우 템플릿 갤러리</h2>
          <p className="text-sm text-muted-foreground">템플릿을 선택해 단계별 담당 에이전트를 배정합니다.</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cyclicDefinitions.map(def => (
            <button
              key={def.id}
              onClick={() => void handleSelectDefinition(def)}
              disabled={loadingBindings}
              // story #3010(로드맵 P3, L1) — 선택 가능한 인라인 카드는 --elev-card.
              className={`rounded-lg border p-4 text-left transition hover:border-primary/60 hover:shadow-[var(--elev-card)] disabled:opacity-60 ${
                selected?.id === def.id ? 'border-primary bg-primary/5' : 'border-border bg-background'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm text-foreground truncate">{def.name || def.key}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{def.description}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StageCountBadge count={cyclicStages(def).length} />
                  {appliedKeys.has(def.key) && (
                    <Badge variant="success" className="text-[10px]">적용됨</Badge>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        {loadingBindings && (
          <p className="mt-4 text-xs text-muted-foreground">배정 정보 로딩 중...</p>
        )}

        {selected && !loadingBindings && (
          <div className="mt-6 rounded-lg border border-border bg-muted/30 p-4 space-y-4">
            <div>
              <h3 className="font-semibold text-sm text-foreground">{selected.name || selected.key} — 역할 매핑</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                각 단계에 프로젝트 에이전트를 연결하세요. 기존 배정이 있으면 아래에 표시됩니다.
              </p>
            </div>

            {requiredStages.map(stage => {
              const meta = selected.stage_metadata[stage];
              return (
                <div key={stage} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-xs font-medium text-foreground">
                    {meta?.role ?? stage}
                  </span>
                  <select
                    className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    value={roleMapping[stage] ?? ''}
                    onChange={e => setRoleMapping(prev => ({ ...prev, [stage]: e.target.value }))}
                  >
                    <option value="">에이전트 선택...</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              );
            })}

            {applyResult && (
              <p
                className={`text-xs ${applyResult.ok ? 'text-success' : 'text-destructive'}`}
                role={applyResult.ok ? 'status' : 'alert'}
                aria-live={applyResult.ok ? 'polite' : 'assertive'}
                aria-atomic="true"
              >
                {applyResult.message}
              </p>
            )}

            <Button
              size="sm"
              disabled={applying || requiredStages.some(s => !roleMapping[s])}
              onClick={() => void handleApply()}
            >
              {applying ? '적용 중...' : (appliedKeys.has(selected.key) ? '재적용(덮어쓰기)' : '적용하기')}
            </Button>
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
