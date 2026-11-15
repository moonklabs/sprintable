'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { EmptyState } from '@/components/ds/empty-state';
import { RowList, RowListItem } from '@/components/ds/row-list';
import { Skeleton } from '@/components/ds/skeleton';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { orderedRecipeRoles, recipeConnectionTargets, roleActorKind, stagesWithGate } from '@/lib/recipe-role-slots';
import { stageRoleLabel } from '@/lib/stage-role';
import { presetDescription, presetName } from '@/lib/platform-preset-copy';

// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §1) 구현. AC1: 마케팅 레시피
// 카드(#4046 useMarketingRecipes 위)와 개발 워크플로를 탭으로 분리한다.
//
// 시안의 검색창·「전체」탭·로드맵 placeholder 카드(「다음 레시피 자리」 2장)는 이 카드 AC1이
// 요구하는 최소 계약(마케팅 카드+워크플로 탭 분리)에 없는 장식/미확定 UI라 뺐다 — 실 데이터
// 없는 자리를 만들지 않는다는 관례(no-sloppy-products) 그대로.

function stageCount(def: EventDefinitionResponse): number {
  return (def.payload_schema.properties?.stage?.enum ?? []).length;
}

// story #4173(유나 디자인 앵커 2026-09-23) — 카드가 «필요한 역할»·«필요한 연결»을 이름으로
// 보여준다. 역할 순서는 적용 다이얼로그 자리 순서와 같은 함수(orderedRecipeRoles).
// 타입을 Record<string, string>으로 둔다 — verify-no-unused-i18n-keys 가드는 정확히 이 모양의
// 리터럴 테이블 값만 «읽힌 키»로 본다. target이 늘면 이 표 한 곳만 고친다.
export const CONNECTION_LABEL_KEY: Record<string, string> = {
  channel_connection: 'recipeCardConnectionChannel',
  generation_connector: 'recipeCardConnectionGenerator',
};

function roleNames(def: EventDefinitionResponse, t: (key: string, values?: Record<string, string>) => string): string[] {
  const flow = def.payload_schema.properties?.stage?.enum ?? [];
  return orderedRecipeRoles(def.stage_metadata, flow, def.role_actor_kinds).map((role) => {
    const label = stageRoleLabel(role, t);
    // story #4243 — either(사람도 에이전트도)에도 접미사(유나 확정: 안 붙이면 «에이전트 전용»으로 읽힌다).
    const kind = roleActorKind(role, def.role_actor_kinds);
    if (kind === 'human') return t('recipeCardHumanRole', { role: label });
    if (kind === 'either') return t('recipeCardEitherRole', { role: label });
    return label;
  });
}

function connectionNames(def: EventDefinitionResponse, t: (key: string, values?: Record<string, string>) => string): string[] {
  return recipeConnectionTargets(def.stage_metadata).map((c) => {
    const name = t(CONNECTION_LABEL_KEY[c.target]!);
    return c.optional ? t('recipeCardConnectionOptional', { name }) : name;
  });
}

function gateCount(def: EventDefinitionResponse): number {
  return stagesWithGate(def.stage_metadata).length;
}

/**
 * 4913(UI-R5) C2 — 레시피 목록: 옛 3열 카드 격자(768 틀 안 세 칸 = 비좁음)를 «한 패널 안 행 목록»(RowList)으로. 보이는 것은 그대로 — 이름 · 설명 · 단계/게이트 수 · 역할 · 연결 · «프로젝트에 적용» · «상세 보기»:
 *  - 줄: 이름 + 설명 한 줄(잘림) + 단계 · 게이트 칩 + 오른쪽 «프로젝트에 적용»
 *  - 줄을 펼치면(Enter · 더블클릭 · 오른쪽 쉐브론) 역할 · 연결 행(옛 카드의 dl)
 *  - «상세 보기» = «⋯» 메뉴 · 우클릭 같은 항목 (눌러서 큰 상세 창)
 */
function RecipeRow({
  recipe, index, expanded, onExpandedChange, onApply, onViewDetail,
}: {
  recipe: EventDefinitionResponse;
  index: number;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onApply?: (recipe: EventDefinitionResponse) => void;
  onViewDetail?: (recipe: EventDefinitionResponse) => void;
}) {
  const t = useTranslations('organization');
  const tPreset = useTranslations('recipePreset');
  const roles = roleNames(recipe, t);
  const connections = connectionNames(recipe, t);
  const description = presetDescription(recipe, tPreset);
  const name = presetName(recipe, tPreset);
  return (
    <RowListItem
      data-testid={`recipe-card-${recipe.id}`}
      title={name}
      subtitle={description || undefined}
      statusMark={(
        <>
          <Chip>{t('recipeGalleryStageCountBadge', { count: stageCount(recipe) })}</Chip>
          <Chip>{t('recipeGalleryGateCountBadge', { count: gateCount(recipe) })}</Chip>
        </>
      )}
      trailing={onApply ? <Button variant="secondary" onClick={() => onApply(recipe)}>{t('recipeGalleryApplyCta')}</Button> : undefined}
      actions={onViewDetail ? [{ key: 'detail', label: t('recipeGalleryDetailCta'), onSelect: () => onViewDetail(recipe) }] : []}
      actionsLabel={t('eventRowActionAriaLabel', { n: index + 1, label: name })}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      expandLabel={t('recipeGalleryDetailCta')}
      onOpen={() => onExpandedChange(true)}
      detail={(
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ds-small">
          <dt className="text-ds-ink-3">{t('recipeCardRolesLabel')}</dt>
          <dd className={roles.length > 0 ? 'm-0 break-keep text-ds-ink' : 'm-0 break-keep text-ds-ink-3'} data-testid="recipe-card-roles">
            {roles.length > 0 ? roles.join(' · ') : t('recipeCardConnectionNone')}
          </dd>
          <dt className="text-ds-ink-3">{t('recipeCardConnectionsLabel')}</dt>
          <dd className={connections.length > 0 ? 'm-0 break-keep text-ds-ink' : 'm-0 break-keep text-ds-ink-3'} data-testid="recipe-card-connections">
            {connections.length > 0 ? connections.join(' · ') : t('recipeCardConnectionNone')}
          </dd>
        </dl>
      )}
    />
  );
}

export interface RecipeListProps {
  recipes: EventDefinitionResponse[];
  loading: boolean;
  error: string | null;
  emptyMessage: string;
  /** RowList의 접근성 이름(한 화면에 목록이 여럿이다). */
  ariaLabel: string;
  onApply?: (recipe: EventDefinitionResponse) => void;
  onViewDetail?: (recipe: EventDefinitionResponse) => void;
}

export function RecipeList({ recipes, loading, error, emptyMessage, ariaLabel, onApply, onViewDetail }: RecipeListProps) {
  const t = useTranslations('organization');
  const [openId, setOpenId] = useState<string | null>(null);
  if (loading) {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="sr-only">{t('recipeGalleryLoading')}</span>
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }
  if (error) return <Banner tone="failed">{t('recipeGalleryLoadError')}</Banner>;
  if (recipes.length === 0) return <Card><EmptyState size="inline" title={emptyMessage} /></Card>;
  return (
    <RowList aria-label={ariaLabel} data-testid="recipe-list">
      {recipes.map((recipe, index) => (
        <RecipeRow
          key={recipe.id}
          recipe={recipe}
          index={index}
          expanded={openId === recipe.id}
          onExpandedChange={(open) => setOpenId(open ? recipe.id : null)}
          onApply={onApply}
          onViewDetail={onViewDetail}
        />
      ))}
    </RowList>
  );
}
