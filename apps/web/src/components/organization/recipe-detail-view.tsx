'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { cyclicStages } from '@/components/loops/loop-create-dialog';
import { groupStagesByRole, stagesWithGate } from '@/lib/recipe-role-slots';
import { gateTypeLabel, gateTypeLabelKey } from '@/lib/gate-type-label';
import { stageRoleLabel } from '@/lib/stage-role';

// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §3) 상세 뷰. 이 화면은 레시피
// «정의»(카탈로그 항목)를 보여주는 것이지 레시피를 적용한 특정 loop 인스턴스의 진행 상태가
// 아니다 — 그래서 시안의 「완료/진행 중」 스텝퍼 색(done/cur)은 옮기지 않는다(정의 자체엔
// "지금 몇 단계인지"가 없다, 그건 loop-detail-client.tsx가 이미 보여주는 다른 화면의 몫).
// 각 단계는 중립 상태로만 그린다.
//
// 게이트 「오늘 엔진에 있음 vs 이 카드가 지음」 구분(시안 범례)은 하드코딩 대신 실 데이터로
// 판별한다 — gateTypeLabelKey(gate.type)가 gate-type-label.ts의 GATE_TYPE_LABEL_KEYS
// 레지스트리(story #3565 정본)에 있으면 "이미 등재된 gate_type"(live), 없으면
// "미등재"(building)다. 특정 gate_type 문자열을 이 파일에 다시 적지 않는다 — 레지스트리가
// 늘어나면 이 판별도 자동으로 따라간다.

const ROLE_DOT_PALETTE = ['bg-info', 'bg-success', 'bg-warning', 'bg-muted-foreground', 'bg-primary', 'bg-destructive'];

function roleColorMap(stageMetadata: EventDefinitionResponse['stage_metadata']): Map<string, string> {
  const roles = Object.keys(groupStagesByRole(stageMetadata));
  return new Map(roles.map((role, i) => [role, ROLE_DOT_PALETTE[i % ROLE_DOT_PALETTE.length]]));
}

export interface RecipeDetailViewProps {
  recipe: EventDefinitionResponse;
  onApply?: () => void;
  onDuplicate?: () => void;
}

export function RecipeDetailView({ recipe, onApply, onDuplicate }: RecipeDetailViewProps) {
  const t = useTranslations('organization');
  const tDash = useTranslations('dashboard');

  const stages = cyclicStages(recipe);
  const roleGroups = groupStagesByRole(recipe.stage_metadata);
  const roleColors = roleColorMap(recipe.stage_metadata);
  const gates = stagesWithGate(recipe.stage_metadata);
  const gateByStage = new Map(gates.map((g) => [g.stage, g]));

  return (
    <div className="space-y-5" data-testid="recipe-detail-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-foreground">{recipe.name || recipe.key}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('recipeDetailSummary', { stageCount: stages.length, gateCount: gates.length, roleCount: Object.keys(roleGroups).length })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t('recipeDetailIrreversibleNote')}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onDuplicate}>{t('recipeDetailDuplicateCta')}</Button>
          <Button size="sm" onClick={onApply}>{t('recipeGalleryApplyCta')}</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground" data-testid="recipe-legend">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-5 rounded-sm border-2 border-primary" /> {t('recipeDetailLegendLive')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-5 rounded-sm border-2 border-warning" /> {t('recipeDetailLegendBuilding')}
        </span>
        {Object.keys(roleGroups).map((role) => (
          <span key={role} className="flex items-center gap-1.5">
            <span className={`inline-block size-1.5 rounded-full ${roleColors.get(role)}`} /> {stageRoleLabel(role, t)}
          </span>
        ))}
      </div>

      {/* story #4054 후속 — 유나 흐름 밴드 스펙(PO 確定, «정의 vs 실행» 혼동 예방). 정적·논리 0.
          story #4424 CI 실측(no-handrolled-card, 2026-09-19) — rounded-xl+border+bg-muted
          트리오가 손코딩 카드로 잡혀 Card 프리미티브(surface="subtle")로 교체. */}
      <Card surface="subtle" radius="compact" className="px-[15px] py-3 flex items-center gap-2.5 flex-wrap" data-testid="recipe-flow-band">
        <div className="flex flex-col">
          <span className="text-[10px] font-bold text-muted-foreground">{t('recipeFlowRecipeLabel')}</span>
          <span className="text-xs text-muted-foreground">{t('recipeFlowRecipeValue')}</span>
        </div>
        <span className="text-muted-foreground text-[11.5px]">→</span>
        <div className="bg-info-tint border border-brand rounded-lg px-2.5 py-1">
          {/* text-brand(#0.56L) on bg-info-tint 소형 텍스트=AA 4.0(<4.5, 실측) — 라벨은
              text-foreground(고대비 14.5+)로, 강조는 border-brand(비텍스트 3:1 기준 4.0+로
              충분)에만 맡긴다. */}
          <span className="text-foreground text-[10px] font-bold block">{t('recipeFlowWorkflowLabel')}</span>
          <span className="text-foreground text-xs font-semibold">{recipe.name || recipe.key}</span>
        </div>
        <span className="text-muted-foreground text-[11.5px]">→</span>
        <div className="flex flex-col">
          <span className="text-[10px] font-bold text-muted-foreground">{t('recipeFlowEventLabel')}</span>
          <span className="text-xs text-muted-foreground">{t('recipeFlowEventValue')}</span>
        </div>
        <span className="text-muted-foreground text-[11.5px]">→</span>
        <div className="flex flex-col">
          <span className="text-[10px] font-bold text-muted-foreground">{t('recipeFlowRunLabel')}</span>
          <span className="text-xs text-muted-foreground">{t('recipeFlowRunValue')}</span>
        </div>
        <span className="ml-auto text-right max-w-[205px] text-[10.5px] text-muted-foreground">{t('recipeFlowCaption')}</span>
      </Card>

      <div className="flex items-stretch gap-0 overflow-x-auto pt-6" data-testid="recipe-stepper">
        {stages.map((stage, i) => {
          const meta = recipe.stage_metadata[stage];
          const gate = gateByStage.get(stage);
          const isLive = gate ? gateTypeLabelKey(gate.gate.type) !== null : false;
          return (
            <div key={stage} className="flex items-stretch">
              <div className="flex w-28 flex-col items-center text-center">
                <div className="flex size-8 items-center justify-center rounded-full border-2 border-border bg-card text-xs font-bold text-muted-foreground">
                  {i + 1}
                </div>
                <div className="mt-2 text-xs font-semibold text-foreground">{stage}</div>
                {meta?.role ? (
                  <div className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground">
                    <span className={`inline-block size-1.5 rounded-full ${roleColors.get(meta.role)}`} /> {stageRoleLabel(meta.role, t)}
                  </div>
                ) : null}
              </div>
              {gate && i < stages.length - 1 ? (
                <div className="flex w-2 flex-col items-center" data-testid={`gate-marker-${stage}`}>
                  <div className={`h-8 w-0 border-l-2 ${isLive ? 'border-primary' : 'border-warning'}`} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="recipe-gate-detail">
        {gates.map((g) => {
          const isLive = gateTypeLabelKey(g.gate.type) !== null;
          return (
            <Card key={g.stage} className={isLive ? 'border-l-4 border-l-primary' : 'border-l-4 border-l-warning'}>
              <CardBody className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  {gateTypeLabel(tDash, g.gate.type)}
                  <Badge variant={isLive ? 'info' : 'warning'}>
                    {isLive ? t('recipeDetailGateLiveBadge') : t('recipeDetailGateBuildingBadge')}
                  </Badge>
                </div>
                {g.gate.approver ? <p className="text-[10.5px] text-muted-foreground">{g.gate.approver}</p> : null}
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
