'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { groupStagesByRole, stagesWithGate } from '@/lib/recipe-role-slots';

// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §1) 구현. AC1: 마케팅 레시피
// 카드(#4046 useMarketingRecipes 위)와 개발 워크플로를 탭으로 분리한다.
//
// 시안의 검색창·「전체」탭·로드맵 placeholder 카드(「다음 레시피 자리」 2장)는 이 카드 AC1이
// 요구하는 최소 계약(마케팅 카드+워크플로 탭 분리)에 없는 장식/미확定 UI라 뺐다 — 실 데이터
// 없는 자리를 만들지 않는다는 관례(no-sloppy-products) 그대로.

function stageCount(def: EventDefinitionResponse): number {
  return (def.payload_schema.properties?.stage?.enum ?? []).length;
}

function roleCount(def: EventDefinitionResponse): number {
  return Object.keys(groupStagesByRole(def.stage_metadata)).length;
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
  return (
    <Card data-testid={`recipe-card-${recipe.id}`}>
      <CardBody className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-foreground">{recipe.name || recipe.key}</h4>
        {recipe.description ? <p className="min-h-8 text-xs text-muted-foreground">{recipe.description}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{t('recipeGalleryStageCountBadge', { count: stageCount(recipe) })}</Badge>
          <Badge variant="outline">{t('recipeGalleryGateCountBadge', { count: gateCount(recipe) })}</Badge>
          <Badge variant="outline">{t('recipeGalleryRoleCountBadge', { count: roleCount(recipe) })}</Badge>
        </div>
        <div className="mt-1 flex gap-2">
          <Button size="sm" onClick={() => onApply?.(recipe)}>{t('recipeGalleryApplyCta')}</Button>
          <Button size="sm" variant="ghost" onClick={() => onViewDetail?.(recipe)}>{t('recipeGalleryDetailCta')}</Button>
        </div>
      </CardBody>
    </Card>
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
