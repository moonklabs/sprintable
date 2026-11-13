'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { CountBadge } from '@/components/ds/count-badge';
import { EmptyState } from '@/components/ds/empty-state';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { RowList, RowListItem, type RowAction } from '@/components/ds/row-list';
import { Skeleton } from '@/components/ds/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ds/tabs';
import { useToast } from '@/components/ds/toast';
import { OrgScreenTitle } from '@/components/organization/org-screen-title';


import { EventDefinitionSummary } from '@/components/organization/event-definition-summary';
import { ApplyRecipeDialog } from '@/components/organization/apply-recipe-dialog';
import { RecipeList } from '@/components/organization/recipe-gallery';
import { MarketingRecipeApplyDialog, submitMarketingRecipeApply } from '@/components/organization/marketing-recipe-apply-dialog';
import { stageRoleLabel } from '@/lib/stage-role';
import { cyclicStages, isCyclicDefinition, type EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { publishHistorySenderLabel } from '@/lib/member-display';
import { useMarketingRecipes } from '@/hooks/use-marketing-recipes';
import { recipeKeyDomain } from '@/lib/recipe-role-slots';
import { presetAction, presetName } from '@/lib/platform-preset-copy';
import { useFlatHref } from '@/hooks/use-flat-href';

import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { DeactivateEventDialog, EventFormDialog, RecipeDetailDialog, TestPublishDialog, type EventDefinition } from '@/components/organization/event-definition-dialogs';

export default function OrganizationEventsPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug ?? '';
  const isAdmin = currentRole === 'admin' || currentRole === 'owner';
  const t = useTranslations('organization');
  const tc = useTranslations('common');
  const { addToast } = useToast();

  const [defs, setDefs] = useState<EventDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EventDefinition | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<EventDefinition | null>(null);
  const [publishTarget, setPublishTarget] = useState<EventDefinition | null>(null);
  const [applyTarget, setApplyTarget] = useState<EventDefinition | null>(null);

  // story #4049 — 마케팅 레시피 탭(#4046 데이터층 + #4048 컴포넌트). 기존 defs/customDefs/
  // presetDefs·위 5개 state와 완전히 독립 — 이 탭이 잘못돼도 개발 워크플로 탭(기존 CRUD)은
  // 무영향(회귀 0 보장 축).
  const { recipes: marketingRecipes, loading: marketingLoading, error: marketingError } = useMarketingRecipes();
  const [marketingApplyTarget, setMarketingApplyTarget] = useState<(EventDefinitionResponse & { id: string }) | null>(null);
  const [marketingDetailTarget, setMarketingDetailTarget] = useState<EventDefinitionResponse | null>(null);
  const [marketingProjects, setMarketingProjects] = useState<{ id: string; name: string }[]>([]);
  // story #4107 CHANGES(페드루 PO 리뷰, 2026-09-21) — apply 응답에 warnings가 있으면
  // 저장은 이미 끝났지만(bindingsUpserted > 0) 사용자가 경고를 확認할 때까지 성공 처리
  // (토스트+상세 뷰)를 «버리지 않고 미룬다». 다이얼로그가 그 상태에선 「확認」 단일
  // 버튼만 보여주므로(marketing-recipe-apply-dialog.tsx), onOpenChange(false)가 오는
  // 시점 = 사용자가 경고를 읽고 확認한 시점 — 그때 이 값을 소비해 성공 경로를 이어간다.
  const [marketingApplyPendingDetailTarget, setMarketingApplyPendingDetailTarget] = useState<EventDefinitionResponse | null>(null);
  // story #4118 — 토스트 count는 실 upsert 건수여야 한다(리터럴 1 고정 결함 재발
  // 방지). onOpenChange가 소비하는 시점엔 onSubmit의 result가 이미 클로저 밖이라
  // 값을 들고 있어야 한다 — pending target과 같은 생애주기로 짝지어 저장.
  const [marketingApplyPendingBindingsCount, setMarketingApplyPendingBindingsCount] = useState(0);

  useEffect(() => {
    if (!marketingApplyTarget) return;
    void (async () => {
      const res = await fetchWithAuth('/api/projects');
      if (!res.ok) return;
      const json = await res.json() as { data?: { id: string; name: string }[] };
      setMarketingProjects((json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    })();
  }, [marketingApplyTarget]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/api/events/definitions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as EventDefinition[] | { data?: EventDefinition[] };
      setDefs(Array.isArray(json) ? json : (json.data ?? []));
    } catch (error) {
      addToast({ type: 'error', title: t('eventErrorGeneric'), body: error instanceof Error ? error.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [addToast, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const presetDefs = defs.filter((d) => d.org_id === null);
  const customDefs = defs.filter((d) => d.org_id !== null);
  // story #4049 — 개발 워크플로 탭은 마케팅 도메인 프리셋만 뺀다(중복 카드 방지) — org
  // 커스텀 정의는 recipeKeyDomain이 항상 null이라(org.{slug}.* 접두, preset. 아님) 이
  // 필터에 안 걸린다, customDefs는 무영향.
  const workflowPresetDefs = presetDefs.filter((d) => recipeKeyDomain(d.key) !== 'marketing');

  const deactivate = async (def: EventDefinition) => {
    if (!def.id) return;
    setDeactivateTarget(null);
    try {
      const res = await fetch(`/api/events/definitions/${def.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      addToast({ type: 'success', title: t('eventDeactivateSuccessToast') });
      await refresh();
    } catch (error) {
      addToast({ type: 'error', title: t('eventErrorGeneric'), body: error instanceof Error ? error.message : undefined });
    }
  };

  return (
    <>
      {/* 4913 C2 — 제목은 위 막대, 본문은 한 쪽 틀(reading). 머리 = 설명 한 줄 + 오른쪽 «새 워크플로우»(관리자만). */}
      <OrgScreenTitle>{t('eventsTitle')}</OrgScreenTitle>
      <PageFrame width="reading">
        <PageHead
          description={t('eventsDescription')}
          actions={isAdmin ? <Button variant="primary" onClick={() => setCreateOpen(true)}>{t('eventCreateCta')}</Button> : undefined}
        />

        {!isAdmin ? <Banner tone="info">{t('eventReadonlyNotAdmin')}</Banner> : null}

        {/* story #4049(E-RECIPE-1 ①) — 마케팅/개발 워크플로 탭 분리(AC1). 「개발 워크플로」 탭 안은 기존 커스텀/프리셋 CRUD 전부 그대로(제거 0, AC3) — 마케팅 탭만 신규.
            story #4049 후속(페드루 PO, 2026-09-19) — 이 표면은 레시피-first라 기본 탭은 marketing. */}
        <Tabs defaultValue="marketing">
          <TabsList aria-label={t('eventsTitle')}>
            <TabsTrigger value="marketing">
              {t('recipeGalleryTabMarketing')} <span className="text-ds-ink-3">{marketingRecipes.length}</span>
            </TabsTrigger>
            <TabsTrigger value="workflow">
              {t('recipeGalleryTabWorkflow')} <span className="text-ds-ink-3">{workflowPresetDefs.length + customDefs.length}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="marketing" className="pt-4">
            <RecipeList
              ariaLabel={t('recipeGalleryTabMarketing')}
              recipes={marketingRecipes}
              loading={marketingLoading}
              error={marketingError}
              emptyMessage={t('recipeGalleryEmpty')}
              onApply={(recipe) => setMarketingApplyTarget(recipe)}
              onViewDetail={(recipe) => setMarketingDetailTarget(recipe)}
            />
          </TabsContent>

          <TabsContent value="workflow" className="pt-4">
            {loading ? (
              <div role="status" aria-busy="true" className="space-y-3">
                <span className="sr-only">{tc('loading')}</span>
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {/* story #3737(E절, 유나 定) — 수를 제목 문자열 안에 넣지 않는다: 제목 고정 + 수는 옆 건수. */}
                <RowList aria-label={t('eventsCustomGroupTitle')} data-testid="events-custom-list" header={{ title: t('eventsCustomGroupTitle'), count: <CountBadge count={customDefs.length} />, level: 2 }}>
                  {customDefs.length > 0 ? customDefs.map((def, index) => (
                    <EventDefRow
                      key={def.key}
                      def={def}
                      index={index}
                      expanded={expandedKey === def.key}
                      onExpandedChange={(open) => setExpandedKey(open ? def.key : null)}
                      readonly={false}
                      isAdmin={isAdmin}
                      onEdit={() => setEditTarget(def)}
                      onDeactivate={() => setDeactivateTarget(def)}
                      onTestPublish={() => setPublishTarget(def)}
                      onApply={() => setApplyTarget(def)}
                      t={t}
                    />
                  )) : (
                    <div role="listitem"><EmptyState size="inline" title={t('eventsEmpty')} /></div>
                  )}
                </RowList>

                <RowList
                  aria-label={t('eventsPresetGroupTitle')}
                  data-testid="events-preset-list"
                  header={{ title: t('eventsPresetGroupTitle'), count: <CountBadge count={workflowPresetDefs.length} />, level: 2, description: t('eventsPresetReadonlyNote') }}
                >
                  {workflowPresetDefs.length > 0 ? workflowPresetDefs.map((def, index) => (
                    <EventDefRow
                      key={def.key}
                      def={def}
                      index={index}
                      expanded={expandedKey === def.key}
                      onExpandedChange={(open) => setExpandedKey(open ? def.key : null)}
                      readonly
                      isAdmin={isAdmin}
                      onApply={() => setApplyTarget(def)}
                      t={t}
                    />
                  )) : (
                    <div role="listitem"><EmptyState size="inline" title={t('eventsEmpty')} /></div>
                  )}
                </RowList>
              </div>
            )}
          </TabsContent>
        </Tabs>

        <EventFormDialog
          mode="create"
          open={createOpen}
          onOpenChange={setCreateOpen}
          orgSlug={orgSlug}
          onSaved={async () => { await refresh(); }}
          t={t}
          tc={tc}
          addToast={addToast}
        />

        <EventFormDialog
          mode="edit"
          target={editTarget}
          open={editTarget !== null}
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
          orgSlug={orgSlug}
          onSaved={async () => { setEditTarget(null); await refresh(); }}
          t={t}
          tc={tc}
          addToast={addToast}
        />

        <DeactivateEventDialog
          target={deactivateTarget}
          onOpenChange={(open) => { if (!open) setDeactivateTarget(null); }}
          onConfirm={(def) => void deactivate(def)}
          t={t}
          tc={tc}
        />

        <TestPublishDialog
          target={publishTarget}
          open={publishTarget !== null}
          onOpenChange={(open) => { if (!open) setPublishTarget(null); }}
          t={t}
          tc={tc}
          addToast={addToast}
        />
        <ApplyRecipeDialog
          target={applyTarget && applyTarget.id ? { ...applyTarget, id: applyTarget.id } : null}
          open={applyTarget !== null}
          onOpenChange={(open) => { if (!open) setApplyTarget(null); }}
          t={t}
          tc={tc}
          addToast={addToast}
        />

        {/* story #4049 AC2 — 카드 → 적용(크리에이터 슬롯) → 상세 뷰 도달까지 흐름 연결. */}
        <MarketingRecipeApplyDialog
          recipe={marketingApplyTarget}
          open={marketingApplyTarget !== null}
          onOpenChange={(open) => {
            if (open) return;
            setMarketingApplyTarget(null);
            // story #4107 CHANGES — warnings가 있었으면 다이얼로그는 오직 「확認」 버튼(단일)으로만 닫힌다: 여기 도달 = 사용자가 경고를 확認한 시점 — 그때서야 보류해 둔 성공 처리(토스트+상세 뷰)를 태운다.
            if (marketingApplyPendingDetailTarget) {
              addToast({ type: 'success', title: t('eventApplySuccessToast', { count: marketingApplyPendingBindingsCount }) });
              setMarketingDetailTarget(marketingApplyPendingDetailTarget);
              setMarketingApplyPendingDetailTarget(null);
              setMarketingApplyPendingBindingsCount(0);
            }
          }}
          projects={marketingProjects}
          orgId={orgId}
          onSubmit={async (args) => {
            const result = await submitMarketingRecipeApply(args);
            // story #4426 P1 잔여 — result.ok는 요청 성공 여부일 뿐 실 배정 건수와 무관: bindingsUpserted가 0이면 no-op이라(다이얼로그가 에러를 표면화) 성공 토스트+상세이동을 같이 태우지 않는다.
            if (result.ok && (result.bindingsUpserted ?? 0) > 0) {
              if ((result.warnings ?? []).length === 0) {
                addToast({ type: 'success', title: t('eventApplySuccessToast', { count: result.bindingsUpserted ?? 0 }) });
                // 적용 성공 → 그 자리서 상세 뷰로 이어간다(AC2 "적용→상세 도달").
                setMarketingDetailTarget(marketingApplyTarget);
              } else {
                // story #4107 CHANGES — warnings가 있으면 다이얼로그가 스스로 안 닫는다 — 성공 처리는 닫힐 때(위 onOpenChange, 사용자의 「확認」)까지 미룬다.
                setMarketingApplyPendingDetailTarget(marketingApplyTarget);
                // story #4118 — 위 onOpenChange가 이 시점의 count를 나중에 소비한다.
                setMarketingApplyPendingBindingsCount(result.bindingsUpserted ?? 0);
              }
            }
            return result;
          }}
        />

        <RecipeDetailDialog
          recipe={marketingDetailTarget}
          onOpenChange={(open) => { if (!open) setMarketingDetailTarget(null); }}
          onApply={(recipe) => setMarketingApplyTarget(recipe as EventDefinitionResponse & { id: string })}
          t={t}
        />
      </PageFrame>
    </>
  );
}

// 4913 C2 — 정의 한 줄: 제목 + 코드 키(부제) + 활성/버전 칩 + (사이클형이면) «프로젝트에 적용» + «⋯»(발행 테스트 · 수정 · 비활성화 — 우클릭도 같은 항목) · 펼치면 서식 요약 · 단계 메타 · 발행 기록(관리자). Enter · 더블클릭 · 쉐브론 = 펼침/접힘.
function EventDefRow({
  def, index, expanded, onExpandedChange, readonly, isAdmin, onEdit, onDeactivate, onTestPublish, onApply, t,
}: {
  def: EventDefinition;
  index: number;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  readonly: boolean;
  isAdmin: boolean;
  onEdit?: () => void;
  onDeactivate?: () => void;
  onTestPublish?: () => void;
  onApply?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  // story #2664 — id 없는(구 목록 API, #2663 머지 전) 항목은 수정/비활성 항목을 숨긴다(그릴 수 없는 액션을 보여주는 게 더 나쁘다) — id가 실리는 순간 자동으로 나타난다.
  const tPreset = useTranslations('recipePreset');
  const canMutate = !readonly && isAdmin && !!def.id;
  // story #3316 — "적용"은 사이클형(stage.enum이 있는) 정의에서만 의미가 있다 — isCyclicDefinition()(loop-create-dialog SSOT) 그대로. id 필요조건은 canMutate와 동일 이유.
  const canApply = isAdmin && !!def.id && isCyclicDefinition(def as unknown as EventDefinitionResponse);
  // story #3745 — `name || 폴백`만으론 name=key로 등록된 옛 데이터를 못 잡아 제목 자리 값을 한 곳에서 계산해 부제 판정도 같은 값을 본다. story #4202 — 플랫폼 마케팅 프리셋은 로케일 문안(presetName).
  const localizedName = presetName(def, tPreset);
  const titleLabel = localizedName && localizedName !== def.key ? localizedName : t('eventUnnamedDefinition');
  const actions: RowAction[] = [];
  if (!readonly && isAdmin) actions.push({ key: 'test-publish', label: t('eventTestPublishCta'), disabled: !def.enabled, onSelect: () => onTestPublish?.() });
  if (canMutate) {
    actions.push({ key: 'edit', label: t('eventEditCta'), onSelect: () => onEdit?.() });
    if (def.enabled) actions.push({ key: 'deactivate', label: t('eventDeactivateCta'), variant: 'danger', separatorBefore: true, onSelect: () => onDeactivate?.() });
  }
  return (
    <RowListItem
      data-testid={`event-def-row-${def.key}`}
      title={titleLabel}
      subtitle={titleLabel !== def.key ? <span data-testid={`event-def-key-subtitle-${def.key}`}>{def.key}</span> : undefined}
      statusMark={(
        <>
          <Chip tone={def.enabled ? 'done' : 'neutral'} dot>{def.enabled ? t('eventEnabledBadge') : t('eventDisabledBadge')}</Chip>
          <Chip>{t('eventVersionLabel', { version: def.version })}</Chip>
        </>
      )}
      trailing={canApply ? (
        <Button variant="secondary" onClick={onApply} aria-label={t('eventRowActionAriaLabel', { n: index + 1, label: t('eventApplyCta') })}>{t('eventApplyCta')}</Button>
      ) : undefined}
      actions={actions}
      actionsLabel={t('eventRowActionAriaLabel', { n: index + 1, label: titleLabel })}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      expandLabel={t('recipeGalleryDetailCta')}
      onOpen={() => onExpandedChange(true)}
      detail={<EventDefDetail def={def} isAdmin={isAdmin} t={t} />}
    />
  );
}

// 4913 C2 — 펼침 칸 내용은 «펼쳤을 때만» 그린다(컴포넌트라 접혀 있는 동안 stage 메타 · 발행 이력 조회를 안 탄다 — 옛 화면도 펼칠 때만 그렸다).
function EventDefDetail({ def, isAdmin, t }: { def: EventDefinition; isAdmin: boolean; t: ReturnType<typeof useTranslations> }) {
  const tPreset = useTranslations('recipePreset');
  return (
    <div className="space-y-3" data-testid={`event-def-detail-${def.key}`}>
          {/* story #2677 — 기본 뷰=사람 언어(서식 요약·필드 표·실물 카드), JSON은 「고급」 접기로 존치(EventDefinitionSummary 내부). */}
          <EventDefinitionSummary
            payloadSchema={def.payload_schema}
            routing={def.routing}
            actionAuth={def.action_auth}
            blockTemplate={def.block_template}
            definition={def}
          />
          {/* story #3316 — 사이클형 정의의 stage_metadata(role/action/gate/capability)를 카탈로그 상세에도 노출한다. */}
          {cyclicStages(def as unknown as EventDefinitionResponse).length > 0 ? (
            <div className="space-y-1 rounded-ds-control border border-dashed border-ds-line p-2 text-ds-small text-ds-ink-3">
              <p className="m-0 font-medium text-ds-ink">{t('eventStageMetaLabel')}</p>
              <ol className="m-0 list-decimal space-y-1 pl-4">
                {cyclicStages(def as unknown as EventDefinitionResponse).map((stage) => {
                  const meta = def.stage_metadata[stage];
                  return (
                    <li key={stage} className="break-words">
                      <span className="font-medium text-ds-ink">{presetAction(def, stage, meta?.action, tPreset)}</span>
                      {meta?.role ? <> ({stageRoleLabel(meta.role, t)})</> : null}
                      {meta?.gate ? <div>{t('eventStageMetaGateLabel', { type: meta.gate.type ?? '' })}</div> : null}
                      {meta?.capability ? <div>{t('eventStageMetaCapabilityLabel', { kind: meta.capability.kind ?? '' })}</div> : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}
          {/* PR#3087 — 이 조회 자체가 BE org admin/owner 게이트라, 일반 멤버는 조회하면 항상 403이라 아예 안 그린다(모두가 여는 매 행마다 헛된 실패 fetch 방지). */}
          {isAdmin ? <PublishHistorySection definitionKey={def.key} t={t} /> : null}
        </div>
  );
}

// story #2665 — PR#3087(디디) 응답 계약 그대로 소비. 신규 로그 테이블 없이
// conversation_messages SSOT 재조회라 정의 하나당 별도 fetch(펼칠 때만 — 목록 전체 N+1 방지).
interface PublishHistoryItem {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  sender_name: string | null;
  created_at: string;
}

type PublishHistoryState = { kind: 'loading' } | { kind: 'resolved'; items: PublishHistoryItem[] } | { kind: 'error' };

function PublishHistorySection({ definitionKey, t }: { definitionKey: string; t: ReturnType<typeof useTranslations> }) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const locale = useLocale();
  const tc = useTranslations('common');
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const [state, setState] = useState<PublishHistoryState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/events/definitions/publish-history?definition_key=${encodeURIComponent(definitionKey)}&limit=20`);
        if (!res.ok) throw new Error();
        const items = await res.json() as PublishHistoryItem[];
        if (!cancelled) setState({ kind: 'resolved', items });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [definitionKey]);

  return (
    <div>
      <p className="m-0 mb-1 text-ds-small font-semibold text-ds-ink-3">{t('eventPublishHistoryLabel')}</p>
      {state.kind === 'loading' ? (
        <p className="m-0 text-ds-small text-ds-ink-3">{t('eventPublishHistoryLoading')}</p>
      ) : state.kind === 'error' ? (
        <p className="m-0 text-ds-small text-ds-failed">{t('eventPublishHistoryError')}</p>
      ) : state.items.length === 0 ? (
        <p className="m-0 text-ds-small text-ds-ink-3">{t('eventPublishHistoryEmpty')}</p>
      ) : (
        <ul className="m-0 list-none space-y-1 rounded-ds-control border border-ds-line p-2">
          {state.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-ds-small">
              <span className="text-ds-ink">{publishHistorySenderLabel(item, t, tc)}</span>
              <span className="flex items-center gap-2 text-ds-ink-3">
                {formatViewerRelativeTime(item.created_at, locale, displayTimezone)}
                {/* 대상-프로젝트: 발행 이력 항목엔 대화의 프로젝트가 없다(대화 화면이 착지 뒤 자기 프로젝트로 연다). */}
                <Link href={flatHref(`/chats/${item.conversation_id}`)} className="text-ds-action-text hover:underline">
                  {t('eventPublishHistoryOpenChat')}
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** story #4370 — 이벤트 정의 폼 초안(폼 전체). */
