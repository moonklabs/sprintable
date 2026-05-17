'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface TemplateStep {
  pattern: string;
  role_ref: string;
  default_label?: string;
}

interface WorkflowTemplate {
  slug: string;
  name: string;
  description: string;
  chain_length: number;
  steps: TemplateStep[];
  presets: Record<string, Record<string, string>>;
  rules_template: Record<string, unknown>[];
  is_system: boolean;
}

interface TeamMember {
  id: string;
  name: string;
  type: string;
  role?: string;
}

interface AppliedRule {
  rule_metadata?: { template_slug?: string };
}

function ChainBadge({ length }: { length: number }) {
  const labels: Record<number, string> = { 0: 'Kanban', 1: '1-step', 2: '2-step', 3: '3-step' };
  return (
    <Badge variant="secondary" className="text-[10px]">
      {labels[length] ?? `${length}-step`}
    </Badge>
  );
}

export function WorkflowTemplateGallerySection({
  projectId,
  orgId,
}: {
  projectId: string;
  orgId?: string;
}) {
  const t = useTranslations('settings');

  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [agents, setAgents] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [appliedSlug, setAppliedSlug] = useState<string | null>(null);

  const [roleMapping, setRoleMapping] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [overwriteConfirm, setOverwriteConfirm] = useState(false);

  const requiredSteps = selected
    ? [...new Set(selected.steps.filter(s => s.role_ref).map(s => s.role_ref))]
    : [];

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tmplRes, memberRes, rulesRes] = await Promise.all([
        fetch('/api/workflow-templates'),
        fetch(`/api/team-members?project_id=${projectId}&type=agent`),
        fetch(`/api/v1/agent-routing-rules?project_id=${projectId}`),
      ]);
      if (tmplRes.ok) {
        const data: unknown = await tmplRes.json();
        setTemplates(Array.isArray(data) ? (data as WorkflowTemplate[]) : []);
      }
      if (memberRes.ok) {
        const json = await memberRes.json() as { data?: TeamMember[] } | TeamMember[];
        const members = Array.isArray(json) ? json : ((json as { data?: TeamMember[] }).data ?? []);
        setAgents(members);
      }
      if (rulesRes.ok) {
        const json = await rulesRes.json() as { data?: AppliedRule[] } | AppliedRule[];
        const rules = Array.isArray(json) ? json : ((json as { data?: AppliedRule[] }).data ?? []);
        const slug = rules.find(r => r.rule_metadata?.template_slug)?.rule_metadata?.template_slug ?? null;
        setAppliedSlug(slug);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadData(); }, [loadData]);

  const handleSelectTemplate = async (tmpl: WorkflowTemplate) => {
    setSelected(null);
    setRoleMapping({});
    setApplyResult(null);
    setOverwriteConfirm(false);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/workflow-templates/${tmpl.slug}`);
      if (res.ok) {
        const full = await res.json() as WorkflowTemplate;
        setSelected(full);
      }
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleApply = async (overwrite = false) => {
    if (!selected) return;

    const missing = requiredSteps.filter(ref => !roleMapping[ref]);
    if (missing.length > 0) {
      setApplyResult({ ok: false, message: `역할 매핑 필요: ${missing.join(', ')}` });
      return;
    }

    if (appliedSlug && !overwrite) {
      setOverwriteConfirm(true);
      return;
    }

    setApplying(true);
    setApplyResult(null);
    try {
      const res = await fetch(`/api/workflow-templates/${selected.slug}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          role_mapping: roleMapping,
          overwrite_existing: overwrite || !!appliedSlug,
        }),
      });
      const data = await res.json() as { ok?: boolean; rules_created?: number; detail?: string };
      if (res.ok && data.ok) {
        setApplyResult({ ok: true, message: `규칙 ${String(data.rules_created ?? 0)}개 생성 완료` });
        setAppliedSlug(selected.slug);
        setOverwriteConfirm(false);
      } else {
        setApplyResult({ ok: false, message: (data.detail as string | undefined) ?? '적용 실패' });
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
          <p className="text-sm text-muted-foreground">템플릿을 선택해 라우팅 규칙을 자동 생성합니다.</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {templates.map(tmpl => (
            <button
              key={tmpl.slug}
              onClick={() => void handleSelectTemplate(tmpl)}
              disabled={loadingDetail}
              className={`rounded-lg border p-4 text-left transition hover:border-primary/60 hover:shadow-sm disabled:opacity-60 ${
                selected?.slug === tmpl.slug ? 'border-primary bg-primary/5' : 'border-border bg-background'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm text-foreground truncate">{tmpl.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{tmpl.description}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <ChainBadge length={tmpl.chain_length} />
                  {appliedSlug === tmpl.slug && (
                    <Badge variant="success" className="text-[10px]">적용됨</Badge>
                  )}
                </div>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground/70">
                프리셋 {Object.keys(tmpl.presets ?? {}).length}종
              </p>
            </button>
          ))}
        </div>

        {loadingDetail && (
          <p className="mt-4 text-xs text-muted-foreground">템플릿 로딩 중...</p>
        )}

        {selected && (
          <div className="mt-6 rounded-lg border border-border bg-muted/30 p-4 space-y-4">
            <div>
              <h3 className="font-semibold text-sm text-foreground">{selected.name} — 역할 매핑</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">각 역할에 프로젝트 에이전트를 연결하세요.</p>
            </div>

            {selected.rules_template && selected.rules_template.length > 0 && (
              <div>
                <p className="text-xs font-medium text-foreground mb-1">생성될 규칙 ({selected.rules_template.length}개)</p>
                <ul className="space-y-0.5">
                  {(selected.rules_template as Array<{ name?: string; priority?: number }>).map((r, i) => (
                    <li key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono text-[10px] w-5 text-right shrink-0">{r.priority ?? i + 1}</span>
                      <span className="truncate">{r.name ?? `규칙 ${i + 1}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {requiredSteps.map(ref => {
              const step = selected.steps.find(s => s.role_ref === ref);
              return (
                <div key={ref} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-xs font-medium text-foreground">
                    {step?.default_label ?? ref}
                  </span>
                  <select
                    className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    value={roleMapping[ref] ?? ''}
                    onChange={e => setRoleMapping(prev => ({ ...prev, [ref]: e.target.value }))}
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
              <p className={`text-xs ${applyResult.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
                {applyResult.message}
              </p>
            )}

            {overwriteConfirm ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-muted-foreground">기존 템플릿 규칙이 교체됩니다. 계속하시겠습니까?</p>
                <Button size="sm" variant="destructive" disabled={applying} onClick={() => void handleApply(true)}>
                  교체 적용
                </Button>
                <Button size="sm" variant="outline" onClick={() => setOverwriteConfirm(false)}>취소</Button>
              </div>
            ) : (
              <Button
                size="sm"
                disabled={applying || requiredSteps.some(r => !roleMapping[r])}
                onClick={() => void handleApply(false)}
              >
                {applying ? '적용 중...' : '적용하기'}
              </Button>
            )}
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
