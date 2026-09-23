'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { orderedRecipeRoles, recipeConnectionTargets, roleActorKind, stagesWithGate } from '@/lib/recipe-role-slots';
import { stageRoleLabel } from '@/lib/stage-role';

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
    return roleActorKind(role, def.role_actor_kinds) === 'human' ? t('recipeCardHumanRole', { role: label }) : label;
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

function RecipeCard({
  recipe, onApply, onViewDetail,
}: {
  recipe: EventDefinitionResponse;
  onApply?: (recipe: EventDefinitionResponse) => void;
  onViewDetail?: (recipe: EventDefinitionResponse) => void;
}) {
  const t = useTranslations('organization');
  const roles = roleNames(recipe, t);
  const connections = connectionNames(recipe, t);
  return (
    <Card className="h-full" data-testid={`recipe-card-${recipe.id}`}>
      <CardBody className="flex h-full flex-col gap-2">
        <h4 className="text-sm font-semibold text-foreground">{recipe.name || recipe.key}</h4>
        {recipe.description ? <p className="min-h-8 text-xs text-muted-foreground">{recipe.description}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{t('recipeGalleryStageCountBadge', { count: stageCount(recipe) })}</Badge>
          <Badge variant="outline">{t('recipeGalleryGateCountBadge', { count: gateCount(recipe) })}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border pt-2 text-xs">
          <dt className="text-muted-foreground">{t('recipeCardRolesLabel')}</dt>
          <dd className={roles.length > 0 ? 'break-keep text-foreground' : 'break-keep text-muted-foreground'} data-testid="recipe-card-roles">
            {roles.length > 0 ? roles.join(' · ') : t('recipeCardConnectionNone')}
          </dd>
          <dt className="text-muted-foreground">{t('recipeCardConnectionsLabel')}</dt>
          <dd className={connections.length > 0 ? 'break-keep text-foreground' : 'break-keep text-muted-foreground'} data-testid="recipe-card-connections">
            {connections.length > 0 ? connections.join(' · ') : t('recipeCardConnectionNone')}
          </dd>
        </dl>
        <div className="mt-auto flex gap-2 pt-1">
          <Button size="sm" onClick={() => onApply?.(recipe)}>{t('recipeGalleryApplyCta')}</Button>
          <Button size="sm" variant="ghost" onClick={() => onViewDetail?.(recipe)}>{t('recipeGalleryDetailCta')}</Button>
        </div>
      </CardBody>
    </Card>
  );
}

export interface RecipeCardGridProps {
  recipes: EventDefinitionResponse[];
  loading: boolean;
  error: string | null;
  emptyMessage: string;
  onApply?: (recipe: EventDefinitionResponse) => void;
  onViewDetail?: (recipe: EventDefinitionResponse) => void;
}

// story #4049(E-RECIPE-1 ①) — events/page.tsx가 «마케팅» 탭 자리를 자기 바깥 탭 체계
// (기존 CRUD 화면의 「개발 워크플로」 탭과 형제)로 이미 갖고 있어, RecipeGallery 자신의
// 내부 탭 chrome을 다시 씌우면 탭 안에 탭이 뜨는 중복이 난다 — 그 페이지가 바로 쓸 수
// 있게 카드 그리드만 떼어 export한다. RecipeGallery 자신은 이걸 안 쓰고 그대로 유지
// (develop 기존 검증된 동작 무변경 — #4424 qa:pass된 loading/error 3분기 그대로).
export function RecipeCardGrid({ recipes, loading, error, emptyMessage, onApply, onViewDetail }: RecipeCardGridProps) {
  const t = useTranslations('organization');
  if (loading) return <p className="text-sm text-muted-foreground">{t('recipeGalleryLoading')}</p>;
  if (error) return <p role="alert" className="text-sm text-destructive">{t('recipeGalleryLoadError')}</p>;
  if (recipes.length === 0) return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {recipes.map((recipe) => (
        <RecipeCard key={recipe.id} recipe={recipe} onApply={onApply} onViewDetail={onViewDetail} />
      ))}
    </div>
  );
}

export interface RecipeGalleryProps {
  marketingRecipes: EventDefinitionResponse[];
  workflowRecipes: EventDefinitionResponse[];
  loading: boolean;
  error: string | null;
  onApply?: (recipe: EventDefinitionResponse) => void;
  onViewDetail?: (recipe: EventDefinitionResponse) => void;
}

export function RecipeGallery({
  marketingRecipes, workflowRecipes, loading, error, onApply, onViewDetail,
}: RecipeGalleryProps) {
  const t = useTranslations('organization');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{t('recipeGalleryTitle')}</h3>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('recipeGalleryDescription')}</p>
      </div>

      <Tabs defaultValue="marketing">
        <TabsList>
          <TabsTrigger value="marketing">
            {t('recipeGalleryTabMarketing')} <span className="text-muted-foreground">{marketingRecipes.length}</span>
          </TabsTrigger>
          <TabsTrigger value="workflow">
            {t('recipeGalleryTabWorkflow')} <span className="text-muted-foreground">{workflowRecipes.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="marketing">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('recipeGalleryLoading')}</p>
          ) : error ? (
            <p role="alert" className="text-sm text-destructive">{t('recipeGalleryLoadError')}</p>
          ) : marketingRecipes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('recipeGalleryEmpty')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {marketingRecipes.map((recipe) => (
                <RecipeCard key={recipe.id} recipe={recipe} onApply={onApply} onViewDetail={onViewDetail} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="workflow">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('recipeGalleryLoading')}</p>
          ) : error ? (
            <p role="alert" className="text-sm text-destructive">{t('recipeGalleryLoadError')}</p>
          ) : workflowRecipes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('recipeGalleryWorkflowEmpty')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {workflowRecipes.map((recipe) => (
                <RecipeCard key={recipe.id} recipe={recipe} onApply={onApply} onViewDetail={onViewDetail} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
