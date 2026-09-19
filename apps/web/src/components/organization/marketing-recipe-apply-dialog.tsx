'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { expandRoleSlotBindings, groupStagesByRole, stagesWithGate } from '@/lib/recipe-role-slots';
import { useRecipeMemberOptions } from '@/hooks/use-recipe-member-options';

// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §2) 4슬롯 적용 다이얼로그.
// PO 判定(story #4046, 2026-09-18) 그대로 — 네 슬롯은 각자 다른 메커니즘에 꽂힌다:
//   · 크리에이터 = role_binding(agent_member_id) — apply_recipe_role_bindings 실제 제출.
//     이 다이얼로그에서 유일하게 실제로 배선된 자리.
//   · 디렉터(사람) = 게이트 승인 주체 — stage_metadata.gate.approver에 이미 있는 값을
//     읽기 전용으로 보여준다(stagesWithGate). 새 바인딩 축을 만들지 않는다.
//   · 연산·발행자 = 각자 다른 후속 서브시스템(generation_budget·채널 커넥션) — 이 카드
//     범위 밖(미르코와 인터페이스 확認 필요, story #4046 AC 주석) — 구조만 보여주고
//     picker는 비활성.
//
// `creatorRoleLabel`은 이 레시피의 stage_metadata에서 실제로 "크리에이터" 축에 해당하는
// role 문자열을 호출부가 명시한다(role 라벨은 recipe 저자 자유 문자열이라 컴포넌트가
// 자동 추론하지 않는다 — recipe-role-slots.ts 설계 그대로).

export interface MarketingRecipeApplyDialogProps {
  recipe: (EventDefinitionResponse & { id: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatorRoleLabel: string;
  projects: { id: string; name: string }[];
  onSubmit: (args: { recipeId: string; projectId: string; roleMapping: Record<string, string> }) => Promise<{ ok: boolean; error?: string }>;
}

export function MarketingRecipeApplyDialog({
  recipe, open, onOpenChange, creatorRoleLabel, projects, onSubmit,
}: MarketingRecipeApplyDialogProps) {
  const t = useTranslations('organization');
  const tc = useTranslations('common');
  const [projectId, setProjectId] = useState('');
  const [creatorAgentId, setCreatorAgentId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { options, loading: loadingMembers } = useRecipeMemberOptions(projectId || null);
  const agentOptions = options.filter((o) => o.type === 'agent');

  useEffect(() => {
    if (!open) return;
    setProjectId('');
    setCreatorAgentId('');
    setError(null);
  }, [open]);

  // 페드루 QA 지적(#4424 qa:changes, 2026-09-19) — 프로젝트 전환 시 이전 선택이 그대로
  // 남아 있으면(agentOptions가 새 프로젝트 것으로 바뀌어도 creatorAgentId state는 그대로)
  // <select>는 화면상 빈칸으로 보이지만 state는 옛 project의 agent id를 쥐고 있어 제출
  // 시 그대로 실린다. 프로젝트가 바뀔 때마다 선택을 명시적으로 비운다.
  useEffect(() => {
    setCreatorAgentId('');
  }, [projectId]);

  if (!recipe) return null;

  const roleGroups = groupStagesByRole(recipe.stage_metadata);
  const creatorStageCount = roleGroups[creatorRoleLabel]?.length ?? 0;
  const gates = stagesWithGate(recipe.stage_metadata);
  // 디렉터 슬롯 읽기 전용 표시용 — 이 레시피의 게이트 approver들(보통 전부 동일값, org_owner).
  const gateApprovers = Array.from(new Set(gates.map((g) => g.gate.approver).filter((a): a is string => !!a)));

  const submit = async () => {
    if (!projectId || !creatorAgentId) return;
    // 페드루 QA 지적(#4424 qa:changes) — 위 useEffect가 전환 시 선택을 비우지만, 그
    // 방어 하나에만 기대지 않고 제출 시점에도 소속(멤버십)을 다시 확認한다(fetch race 등
    // 어떤 경로로든 project와 어긋난 agentId가 실리지 않게 하는 마지막 문).
    if (!agentOptions.some((a) => a.id === creatorAgentId)) {
      setError(t('recipeApplyV2CreatorMembershipError'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const roleMapping = expandRoleSlotBindings(recipe.stage_metadata, [creatorRoleLabel], {
        [creatorRoleLabel]: creatorAgentId,
      });
      const result = await onSubmit({ recipeId: recipe.id, projectId, roleMapping });
      if (!result.ok) {
        setError(result.error ?? t('eventApplyErrorGeneric'));
        return;
      }
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('recipeApplyV2Title', { name: recipe.name || recipe.key })}</DialogTitle>
          <DialogDescription>{t('recipeApplyV2Description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="marketing-recipe-apply-project" className="text-xs font-medium text-muted-foreground">
            {t('eventApplyProjectLabel')}
          </label>
          <select
            id="marketing-recipe-apply-project"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('eventApplyProjectPlaceholder')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div className="space-y-2.5">
          {/* 디렉터 — 읽기 전용(게이트 승인 주체, role_mapping 축 아님) */}
          <div className="flex items-center gap-3 rounded-md border border-input p-3" data-testid="slot-director">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {t('recipeApplyV2DirectorRole')} <Badge variant="secondary">{t('recipeApplyV2DirectorBadge')}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2DirectorDesc')}</p>
            </div>
            <div className="shrink-0 text-xs text-muted-foreground" data-testid="director-approver">
              {gateApprovers.length > 0 ? gateApprovers.join(', ') : '—'}
            </div>
          </div>

          {/* 크리에이터 — 실제 role_binding 축 */}
          <div className="flex items-center gap-3 rounded-md border border-input p-3" data-testid="slot-creator">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {t('recipeApplyV2CreatorRole')} <Badge variant="secondary">{t('recipeApplyV2CreatorBadge')}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2CreatorDesc')}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('recipeApplyV2StageCoverage', { count: creatorStageCount })}</p>
            </div>
            <select
              className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={creatorAgentId}
              onChange={(e) => setCreatorAgentId(e.target.value)}
              disabled={!projectId || loadingMembers}
              data-testid="creator-agent-select"
            >
              <option value="">{t('eventApplyAgentPlaceholder')}</option>
              {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          {/* 연산 — 이 카드 범위 밖(generation_budget, 미르코와 인터페이스 확認 필요) */}
          <div className="flex items-center gap-3 rounded-md border border-dashed border-input p-3 opacity-70" data-testid="slot-compute">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {t('recipeApplyV2ComputeRole')} <Badge variant="secondary">{t('recipeApplyV2ComputeBadge')}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2ComputeDesc')}</p>
            </div>
            <select className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-muted-foreground" disabled>
              <option>{t('recipeApplyV2ModelSetPlaceholder')}</option>
            </select>
          </div>

          {/* 발행자 — 이 카드 범위 밖(채널 커넥션, 미르코와 인터페이스 확認 필요) */}
          <div className="flex items-center gap-3 rounded-md border border-dashed border-input p-3 opacity-70" data-testid="slot-publisher">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {t('recipeApplyV2PublisherRole')} <Badge variant="secondary">{t('recipeApplyV2PublisherBadge')}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2PublisherDesc')}</p>
            </div>
            <select className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-muted-foreground" disabled>
              <option>{t('recipeApplyV2ChannelPlaceholder')}</option>
            </select>
          </div>

          <p className="rounded-md border border-dashed border-input bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
            {t('recipeApplyV2ContractNote')}
          </p>
        </div>

        {error ? (
          <p role="alert" aria-live="assertive" className="rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{tc('cancel')}</Button>
          <Button onClick={() => void submit()} disabled={submitting || !projectId || !creatorAgentId}>
            {submitting ? t('eventApplySubmitting') : t('eventApplySubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** MarketingRecipeApplyDialog의 onSubmit 구현을 표준 계약(POST .../apply)으로 감싼다 —
 * 페이지가 직접 fetch 배선을 새로 쓰지 않고 이걸 넘기면 된다(apply-recipe-dialog.tsx와
 * 동일 엔드포인트·바디 shape, 신규 백엔드 없음). */
export async function submitMarketingRecipeApply(
  { recipeId, projectId, roleMapping }: { recipeId: string; projectId: string; roleMapping: Record<string, string> },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchWithAuth(`/api/events/definitions/${recipeId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, role_mapping: roleMapping }),
  });
  // story #4424 CI 실측(no-fetch-response-without-ok-check, 2026-09-19) — res.ok 검사를
  // .json() 앞으로 옮긴다(가드 300자 윈도우 근접 미스가 아니라, 실패 바디도 에러 메시지
  // 추출을 위해 파싱은 하되 그 판단이 res.ok 분기 안에서 먼저 이뤄지게 명시).
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as { error?: { message?: string } };
    return { ok: false, error: errBody.error?.message };
  }
  const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: { message?: string } };
  if (!data.ok) return { ok: false, error: data.error?.message };
  return { ok: true };
}
