'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { Input } from '@/components/ui/input';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { EventDefinerForm } from '@/components/organization/event-definer-form';
import {
  type DefinerFormState, deriveDefinition, emptyFormState, tryReverseParse, validateKeySuffix,
} from '@/components/organization/event-definer-logic';
import { EventDefinitionSummary } from '@/components/organization/event-definition-summary';
import { ApplyRecipeDialog } from '@/components/organization/apply-recipe-dialog';
import { RecipeCardGrid } from '@/components/organization/recipe-gallery';
import { MarketingRecipeApplyDialog, submitMarketingRecipeApply } from '@/components/organization/marketing-recipe-apply-dialog';
import { RecipeDetailView } from '@/components/organization/recipe-detail-view';
import { stageRoleLabel } from '@/lib/stage-role';
import { cyclicStages, isCyclicDefinition, type EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { publishHistorySenderLabel } from '@/lib/member-display';
import { useMarketingRecipes } from '@/hooks/use-marketing-recipes';
import { recipeKeyDomain } from '@/lib/recipe-role-slots';
import { presetAction, presetName } from '@/lib/platform-preset-copy';

// story #2664 — 목록(GET) 응답 모델(events.py EventDefinitionResponse)엔 아직 id가 없다
// (BE #2663, PR#3069 재QA 중). id가 없는 항목은 수정/비활성 버튼을 아예 안 그린다 — #2663가
// 머지되는 순간 이 화면은 코드 변경 없이 그 즉시 전 항목에서 수정/비활성이 열린다(forward-compat).
// story #3316 — name/description/stage_metadata를 loops/loop-create-dialog.tsx의
// EventDefinitionResponse(SSOT)에서 그대로 얹는다(중복 선언 대신 재사용) — 카탈로그 상세 뷰가
// 사이클형 정의의 stage_metadata(role/action/gate/capability)를 렌더링하고, "프로젝트에 적용"
// 진입점(ApplyRecipeDialog)이 cyclicStages()/isCyclicDefinition() 판별을 그대로 재사용한다.
interface EventDefinition extends Pick<EventDefinitionResponse, 'name' | 'description' | 'stage_metadata'> {
  id?: string;
  key: string;
  org_id: string | null;
  // cyclicStages()/isCyclicDefinition()(loop-create-dialog.tsx SSOT)이 요구하는
  // properties.stage.enum 형태와 EventDefinitionSummary가 요구하는 Record<string, unknown>을
  // 교집합으로 동시에 만족 — 이 화면이 두 소비처(요약 렌더러+사이클 판별)에 같은 필드를 넘긴다.
  payload_schema: EventDefinitionResponse['payload_schema'] & Record<string, unknown>;
  routing: Record<string, unknown>;
  block_template: Record<string, unknown> | null;
  action_auth?: Record<string, unknown> | null;
  enabled: boolean;
  version: number;
}

const DEFAULT_PAYLOAD_SCHEMA = '{\n  "type": "object",\n  "properties": {},\n  "required": [],\n  "additionalProperties": false\n}';
const DEFAULT_ROUTING = '{\n  "escalation": { "kind": "server_derived", "target": "none" },\n  "broadcast": { "kind": "server_derived", "target": "none" }\n}';

// PO 리뷰(PR#3070) 기록사항① — raw SyntaxError 영문을 그대로 보여주지 않는다(#2552 사람말
// 에러 카피 원칙). 어느 필드가 깨졌는지(field) 호출부가 t('eventJsonParseError', {field})로
// 로컬라이즈해 보여줄 수 있게 field만 실어 던진다.
class JsonFieldParseError extends Error {
  constructor(public field: string) { super(`invalid_json:${field}`); }
}

function parseJsonField(raw: string, field: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new JsonFieldParseError(field);
  }
}

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
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">{t('eventsTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('eventsDescription')}</p>
        </div>
        {isAdmin ? (
          <Button onClick={() => setCreateOpen(true)}>{t('eventCreateCta')}</Button>
        ) : null}
      </div>

      {!isAdmin ? (
        <p className="text-sm text-muted-foreground">{t('eventReadonlyNotAdmin')}</p>
      ) : null}

      {/* story #4049(E-RECIPE-1 ①) — 마케팅/개발 워크플로 탭 분리(AC1). 「개발 워크플로」
          탭 안은 기존 커스텀/프리셋 CRUD 전부 그대로(제거 0, AC3) — 마케팅 탭만 신규
          #4046/#4048 위에 얹은 것. */}
      {/* story #4049 후속(페드루 PO, 2026-09-19, [시안이탈첫노출]) — 이 표면은 E-RECIPE-1
          레시피-first 의도(customer-zero가 레시피 적용하러 오는 자리)라 기본 탭을
          marketing으로. workflow-default는 구 events 페이지 보존 논리였다. */}
      <Tabs defaultValue="marketing">
        <TabsList>
          <TabsTrigger value="marketing">
            {t('recipeGalleryTabMarketing')} <span className="text-muted-foreground">{marketingRecipes.length}</span>
          </TabsTrigger>
          <TabsTrigger value="workflow">
            {t('recipeGalleryTabWorkflow')} <span className="text-muted-foreground">{workflowPresetDefs.length + customDefs.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="marketing">
          <RecipeCardGrid
            recipes={marketingRecipes}
            loading={marketingLoading}
            error={marketingError}
            emptyMessage={t('recipeGalleryEmpty')}
            onApply={(recipe) => setMarketingApplyTarget(recipe)}
            onViewDetail={(recipe) => setMarketingDetailTarget(recipe)}
          />
        </TabsContent>

        <TabsContent value="workflow">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
            </div>
          ) : (
            <div className="space-y-6">
              <SectionCard>
                <SectionCardHeader>
                  {/* story #3737(E절, 유나 定) — 수를 제목 문자열 안에 넣지 않는다.
                      제목 고정 + 수는 옆 배지로(구현 (4)류와 같은 형 문제). */}
                  <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                    {t('eventsCustomGroupTitle')}
                    {/* 페드루 PO 적기만(#4082 리뷰) — CountBadge(trust/page.tsx와 동형). */}
                    <CountBadge count={customDefs.length} />
                  </h2>
                </SectionCardHeader>
                <SectionCardBody>
                  {customDefs.length > 0 ? (
                    <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                      {customDefs.map((def, index) => (
                        <EventDefRow
                          key={def.key}
                          def={def}
                          index={index}
                          expanded={expandedKey === def.key}
                          onToggleExpand={() => setExpandedKey((k) => (k === def.key ? null : def.key))}
                          readonly={false}
                          isAdmin={isAdmin}
                          onEdit={() => setEditTarget(def)}
                          onDeactivate={() => setDeactivateTarget(def)}
                          onTestPublish={() => setPublishTarget(def)}
                          onApply={() => setApplyTarget(def)}
                          t={t}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('eventsEmpty')}</p>
                  )}
                </SectionCardBody>
              </SectionCard>

              <SectionCard>
                <SectionCardHeader>
                  <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                    {t('eventsPresetGroupTitle')}
                    <CountBadge count={workflowPresetDefs.length} />
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">{t('eventsPresetReadonlyNote')}</p>
                </SectionCardHeader>
                <SectionCardBody>
                  {workflowPresetDefs.length > 0 ? (
                    <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
                      {workflowPresetDefs.map((def, index) => (
                        <EventDefRow
                          key={def.key}
                          def={def}
                          index={index}
                          expanded={expandedKey === def.key}
                          onToggleExpand={() => setExpandedKey((k) => (k === def.key ? null : def.key))}
                          readonly
                          isAdmin={isAdmin}
                          // story #3316 — 프리셋도 사이클형이면 gallery와 동형으로 "프로젝트에
                          // 적용" 가능(프리셋=읽기전용은 "정의 자체 수정 불가"만 뜻함, 프로젝트
                          // 바인딩 적용은 별개 축).
                          onApply={() => setApplyTarget(def)}
                          t={t}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('eventsEmpty')}</p>
                  )}
                </SectionCardBody>
              </SectionCard>
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

      <ConfirmDialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => { if (!open) setDeactivateTarget(null); }}
        title={t('eventDeactivateDialogTitle')}
        description={t('eventDeactivateDialogBody', { key: deactivateTarget?.key ?? '' })}
        cancelLabel={tc('cancel')}
        confirmLabel={t('eventDeactivateConfirmCta')}
        onConfirm={() => { if (deactivateTarget) void deactivate(deactivateTarget); }}
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
          // story #4107 CHANGES(페드루 PO 리뷰) — warnings가 있었으면 다이얼로그는 오직
          // 「확認」 버튼(단일)으로만 닫힌다(marketing-recipe-apply-dialog.tsx) — 그러므로
          // 여기 도달 = 사용자가 경고를 확認한 시점. 그때서야 보류해 둔 성공 처리(토스트+
          // 상세 뷰)를 태운다(성공을 버린 게 아니라 닫힐 때까지 미룬 것).
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
          // story #4426 P1 잔여(카디르 재QA, 2026-09-19) — result.ok는 요청 성공 여부일 뿐
          // 실 배정 건수와 무관(백엔드 ApplyRecipeRoleBindingsResponse.ok 계약 그대로) —
          // bindingsUpserted가 0이면 이 서브밋은 no-op이라 다이얼로그가 이미 no-op 에러를
          // 표면화한다(marketing-recipe-apply-dialog.tsx). 그런데 그 경우까지 여기서 성공
          // 토스트+상세이동을 같이 태우면 "성공"과 "no-op 오류"가 한 화면에 공존하는
          // [두문장 다른세계] — 실 배정이 1건이라도 있을 때만 성공 경로를 태운다.
          if (result.ok && (result.bindingsUpserted ?? 0) > 0) {
            if ((result.warnings ?? []).length === 0) {
              addToast({ type: 'success', title: t('eventApplySuccessToast', { count: result.bindingsUpserted ?? 0 }) });
              // 적용 성공 → 그 자리서 상세 뷰로 이어간다(AC2 "적용→상세 도달").
              setMarketingDetailTarget(marketingApplyTarget);
            } else {
              // story #4107 CHANGES — warnings가 있으면 다이얼로그가 스스로 안 닫는다
              // (marketing-recipe-apply-dialog.tsx submit()) — 성공 처리는 버리지 않고
              // 다이얼로그가 닫힐 때(위 onOpenChange, 사용자의 「확認」 클릭)까지 미룬다.
              setMarketingApplyPendingDetailTarget(marketingApplyTarget);
              // story #4118 — 위 onOpenChange가 이 시점의 count를 나중에 소비한다(이
              // 분기에 들어온 순간 (result.bindingsUpserted ?? 0) > 0이 이미 보장돼
              // 있다 — 바깥 if의 조건 그대로).
              setMarketingApplyPendingBindingsCount(result.bindingsUpserted ?? 0);
            }
          }
          return result;
        }}
      />

      <Dialog open={marketingDetailTarget !== null} onOpenChange={(open) => { if (!open) setMarketingDetailTarget(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          {marketingDetailTarget ? (
            <RecipeDetailView
              recipe={marketingDetailTarget}
              onApply={() => setMarketingApplyTarget(marketingDetailTarget)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EventDefRow({
  def, index, expanded, onToggleExpand, readonly, isAdmin, onEdit, onDeactivate, onTestPublish, onApply, t,
}: {
  def: EventDefinition;
  index: number;
  expanded: boolean;
  onToggleExpand: () => void;
  readonly: boolean;
  isAdmin: boolean;
  onEdit?: () => void;
  onDeactivate?: () => void;
  onTestPublish?: () => void;
  onApply?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  // story #2664 — id 없는(구 목록 API, #2663 머지 전) 항목은 수정/비활성 버튼을 숨긴다(그릴 수
  // 없는 액션을 보여주는 게 UX상 더 나쁘다) — id가 실리는 순간 자동으로 나타난다.
  const tPreset = useTranslations('recipePreset');
  const canMutate = !readonly && isAdmin && !!def.id;
  // story #3316 — "적용"은 사이클형(stage.enum이 있는) 정의에서만 의미가 있다(role_mapping이
  // 붙을 stage가 아예 없으면 적용할 게 없다) — isCyclicDefinition()(loop-create-dialog SSOT)
  // 그대로 재사용. id 필요조건은 canMutate와 동일 이유(ApplyRecipeDialog가 /apply 호출에 id 필요).
  const canApply = isAdmin && !!def.id && isCyclicDefinition(def as unknown as EventDefinitionResponse);
  // story #3745(name===key 잔존, 페드루 PO 決 2026-09-09) — `name || 폴백`만으론 org
  // 커스텀 정의가 name=key로(코드 키를 그대로 이름 자리에) 등록된 옛 데이터를 못 잡는다
  // (name이 빈 문자열이 아니라 truthy라 폴백이 안 걸림). 제목 자리 값을 한 곳에서
  // 계산해 아래 부제 판정도 같은 값을 본다.
  // story #4202 — 플랫폼 마케팅 프리셋은 로케일 문안(presetName), 나머지는 원문 판정 그대로.
  const localizedName = presetName(def, tPreset);
  const titleLabel = localizedName && localizedName !== def.key ? localizedName : t('eventUnnamedDefinition');
  return (
    <div className="p-3">
      {/* story #4212(유나 규격 · 390) — 1024 미만은 제목 덩어리 위·버튼 줄 아래로 쌓는다. 예전엔 한 줄 flex에서 왼쪽
          flex-1(기준 폭 0)이 거의 0까지 줄어 제목 «Un…»·배지가 버튼과 겹쳤고, shrink-0 버튼 묶음(최대 4개)이 행 밖으로
          넘쳤다. lg: 이상은 이전 배치 그대로(1440 픽셀 차이 0) — 브레이크포인트는 lg:만(신규 md: 금지 가드). */}
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between" data-testid={`event-def-row-${def.key}`}>
        <div className="min-w-0 lg:flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* story #4215(까디르 QA · 4212 잔여) — 제목 버튼은 flex 항목이라 min-w-0이 없으면 최소 폭 = 가장 긴 낱말:
                공백 없는 긴 제목(합성어·URL 모양·식별자)은 390에서 행 밖으로 넘쳤다. min-w-0으로 줄어들 수 있게 해야 break-words가
                낱말 안에서 끊고, lg:truncate도 실제로 말줄임한다. */}
            <button
              type="button"
              onClick={onToggleExpand}
              className="min-w-0 break-words text-left text-sm text-foreground hover:underline lg:truncate"
              data-testid={`event-def-toggle-${def.key}`}
            >
              {titleLabel}
            </button>
            {/* story #3737(D2, 유나 定) — 정의의 «사람 이름»(표시명)이 눌리는 컨트롤의
                라벨이고, 코드 키는 그 아래 작은 글씨 부제로만.
                story #3745(페드루 PO 決·유나 定 2026-09-09) — name이 비어 있으면(#3737
                D2 잔존) 옛 `name || key` 폴백(raw 코드 키가 제목 자리에 서던 결함)을
                걷고 정직한 「이름 없는 이벤트」로(지어낸 이름 아님 — 모름을 모름이라
                쓴다, D2/D3와 같은 급). 부제는 제목이 이미 key와 같은 값이 아닐 때만
                그린다(title===key인 자리, 예: org 커스텀 정의가 스스로 name=key로
                등록한 옛 데이터)면 같은 값이 한 줄에 두 번 서는 것을 그대로 막는다
                (#4082 CHANGES②와 같은 원칙 — 판정 축만 title로 일반화). */}
            {titleLabel !== def.key ? (
              <span
                data-testid={`event-def-key-subtitle-${def.key}`}
                className="min-w-0 max-w-full truncate font-mono text-[11px] text-muted-foreground"
              >
                {def.key}
              </span>
            ) : null}
            <Badge variant={def.enabled ? 'success' : 'secondary'}>
              {def.enabled ? t('eventEnabledBadge') : t('eventDisabledBadge')}
            </Badge>
            <Badge variant="outline">{t('eventVersionLabel', { version: def.version })}</Badge>
          </div>
        </div>
        {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 접근 이름이라 보조기술
            버튼 목록에서 어느 이벤트 정의 행인지 못 가른다. customDefs·presetDefs는
            화면상 별개 목록(제목이 다른 SectionCard 둘)이라 순번은 각 목록 안에서
            1부터 다시 센다(호출부 두 곳이 각자 map index를 넘긴다). */}
        <div className="flex flex-wrap gap-1.5 lg:shrink-0 lg:flex-nowrap" data-testid={`event-def-actions-${def.key}`}>
          {!readonly && isAdmin ? (
            <Button
              size="sm" variant="ghost" disabled={!def.enabled} onClick={onTestPublish}
              aria-label={t('eventRowActionAriaLabel', { n: index + 1, label: t('eventTestPublishCta') })}
            >
              {t('eventTestPublishCta')}
            </Button>
          ) : null}
          {canApply ? (
            <Button
              size="sm" variant="outline" onClick={onApply}
              aria-label={t('eventRowActionAriaLabel', { n: index + 1, label: t('eventApplyCta') })}
            >
              {t('eventApplyCta')}
            </Button>
          ) : null}
          {canMutate ? (
            <>
              <Button
                size="sm" variant="outline" onClick={onEdit}
                aria-label={t('eventRowActionAriaLabel', { n: index + 1, label: t('eventEditCta') })}
              >
                {t('eventEditCta')}
              </Button>
              {def.enabled ? (
                <Button
                  size="sm" variant="destructive" onClick={onDeactivate}
                  aria-label={t('eventRowActionAriaLabel', { n: index + 1, label: t('eventDeactivateCta') })}
                >
                  {t('eventDeactivateCta')}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="mt-3 space-y-3">
          {/* story #2677 — 기본 뷰=사람 언어(서식 요약·필드 표·실물 카드), JSON은 「고급」
              접기로 존치(EventDefinitionSummary 내부). 역파생 불가(프리셋 전부 포함) 시엔
              정의기 edit 다이얼로그와 같은 규칙으로 정직하게 JSON 기본+고급 전용 배지. */}
          <EventDefinitionSummary
            payloadSchema={def.payload_schema}
            routing={def.routing}
            actionAuth={def.action_auth}
            blockTemplate={def.block_template}
            definition={def}
          />
          {/* story #3316 — 사이클형 정의의 stage_metadata(role/action/gate/capability)를
              카탈로그 상세에도 노출한다(loop-create-dialog.tsx:295-310 렌더 패턴 재사용) —
              지금까지는 loop 생성 다이얼로그 미리보기에서만 보였고, 그 stage 목록이 정확히
              무엇을 뜻하는지 확인할 곳이 카탈로그 자체엔 없었다. */}
          {cyclicStages(def as unknown as EventDefinitionResponse).length > 0 ? (
            <div className="space-y-1 rounded-lg border border-dashed border-border bg-muted/30 p-2 text-[10.5px] text-muted-foreground">
              <p className="font-medium text-foreground">{t('eventStageMetaLabel')}</p>
              <ol className="list-decimal space-y-1 pl-4">
                {cyclicStages(def as unknown as EventDefinitionResponse).map((stage) => {
                  const meta = def.stage_metadata[stage];
                  return (
                    <li key={stage} className="break-words">
                      <span className="font-medium text-foreground">{presetAction(def, stage, meta?.action, tPreset)}</span>
                      {meta?.role ? <> ({stageRoleLabel(meta.role, t)})</> : null}
                      {meta?.gate ? <div>{t('eventStageMetaGateLabel', { type: meta.gate.type ?? '' })}</div> : null}
                      {meta?.capability ? <div>{t('eventStageMetaCapabilityLabel', { kind: meta.capability.kind ?? '' })}</div> : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}
          {/* PR#3087 — 이 조회 자체가 BE org admin/owner 게이트라, 일반 멤버는 조회하면
              항상 403이라 아예 안 그린다(모두가 여는 매 행마다 헛된 실패 fetch 방지). */}
          {isAdmin ? <PublishHistorySection definitionKey={def.key} t={t} /> : null}
        </div>
      ) : null}
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
  const locale = useLocale();
  const tc = useTranslations('common');
  const displayTimezone = resolveDisplayTimezone().tz;
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
      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{t('eventPublishHistoryLabel')}</p>
      {state.kind === 'loading' ? (
        <p className="text-xs text-muted-foreground">{t('eventPublishHistoryLoading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-xs text-destructive">{t('eventPublishHistoryError')}</p>
      ) : state.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('eventPublishHistoryEmpty')}</p>
      ) : (
        <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-2">
          {state.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-foreground">{publishHistorySenderLabel(item, t, tc)}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {formatRelativeTime(item.created_at, locale, displayTimezone)}
                <Link href={`/chats/${item.conversation_id}`} className="text-primary hover:underline">
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

function EventFormDialog({
  mode, target, open, onOpenChange, orgSlug, onSaved, t, tc, addToast,
}: {
  mode: 'create' | 'edit';
  target?: EventDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  onSaved: () => Promise<void>;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  const { currentTeamMemberId } = useDashboardContext();
  const prefix = `org.${orgSlug || '{org}'}.`;
  // story #3745(페드루 PO 決) — 정의 편집 폼에 이름 필드(옛 화면엔 자리 자체가 없었다).
  const [name, setName] = useState('');
  const [keySuffix, setKeySuffix] = useState('');
  const [payloadSchema, setPayloadSchema] = useState(DEFAULT_PAYLOAD_SCHEMA);
  const [routing, setRouting] = useState(DEFAULT_ROUTING);
  const [blockTemplate, setBlockTemplate] = useState('');
  const [humanOnly, setHumanOnly] = useState(false);
  const [rolesCsv, setRolesCsv] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // story #2670(A층) — 「기본」(3서식 폼) / 「고급」(JSON, #3070 원안) 탭. create=항상 기본
  // 시작. edit=기존 JSON을 tryReverseParse로 되돌려 성공하면 기본, 실패(폼이 못 만드는
  // 모양)하면 고급 전용(배지+기본 탭 비활성) — AC3 그대로.
  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');
  const [definerState, setDefinerState] = useState<DefinerFormState>(emptyFormState());
  const [advancedOnly, setAdvancedOnly] = useState(false);
  // 새로 저장한 정의의 실 key(발행 테스트가 필요로 하는 서버측 실체) — create 저장 성공
  // 직후에도 다이얼로그를 닫지 않고 이 값을 채워 그 자리에서 바로 테스트 발행까지 잇는다
  // (스펙 §4 "정의→미리보기→테스트 발행"이 한 세션 안에서 끊기지 않아야 함).
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [testPublishing, setTestPublishing] = useState(false);
  const [testPublishResult, setTestPublishResult] = useState<{ ok: boolean; message?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && target) {
      setName(target.name ?? '');
      setKeySuffix(target.key.startsWith(`org.${orgSlug}.`) ? target.key.slice(`org.${orgSlug}.`.length) : target.key);
      setPayloadSchema(JSON.stringify(target.payload_schema, null, 2));
      setRouting(JSON.stringify(target.routing, null, 2));
      setBlockTemplate(target.block_template ? JSON.stringify(target.block_template, null, 2) : '');
      const auth = target.action_auth as { human_only?: boolean; role?: string[] } | null | undefined;
      setHumanOnly(auth?.human_only ?? false);
      setRolesCsv((auth?.role ?? []).join(', '));

      const parsed = orgSlug ? tryReverseParse(target.key, target.payload_schema, target.routing, target.action_auth ?? null, orgSlug, target.block_template) : null;
      if (parsed) { setDefinerState(parsed); setTab('basic'); setAdvancedOnly(false); }
      else { setDefinerState(emptyFormState()); setTab('advanced'); setAdvancedOnly(true); }
      setSavedKey(target.key);
    } else {
      setName('');
      setKeySuffix('');
      setPayloadSchema(DEFAULT_PAYLOAD_SCHEMA);
      setRouting(DEFAULT_ROUTING);
      setBlockTemplate('');
      setHumanOnly(false);
      setRolesCsv('');
      setDefinerState(emptyFormState());
      setTab('basic');
      setAdvancedOnly(false);
      setSavedKey(null);
    }
    setTestPublishResult(null);
    setError(null);
  }, [open, mode, target, orgSlug]);

  const definerKeyError = tab === 'basic' && mode === 'create' ? validateKeySuffix(definerState.keySuffix) : null;
  // story #2666 — 「고급」탭도 「기본」탭과 같은 key 규격(_ORG_KEY_RE 접미 [a-z0-9_]+)이라
  // 같은 클라 선검증을 재사용한다. 서버 메시지("...로 시작해야 합니다")가 문자셋 위반을
  // 접두 문제로 오진시키던 것 — 클라에서 먼저 정확한 원인(문자셋)을 지목해 그 오진 문구에
  // 도달할 일 자체를 줄인다(서버 검증은 그대로 유지 — 이건 안내일 뿐, 우회 아님).
  const advancedKeyError = tab === 'advanced' && mode === 'create' ? validateKeySuffix(keySuffix) : null;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      // story #3745 — BE가 이미 422로 막지만(공백뿐인 값도) 왕복 없이 그 자리에서 먼저
      // 말해준다(정의 폼의 다른 필드들과 같은 클라측 선검증 관례, definerKeyError와 동형).
      if (!name.trim()) throw new Error(t('eventNameRequiredError'));
      let body: Record<string, unknown>;
      if (tab === 'basic') {
        if (definerKeyError) throw new Error(definerKeyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset'));
        const derived = deriveDefinition(definerState, orgSlug);
        body = {
          name: name.trim(),
          payload_schema: derived.payload_schema,
          routing: derived.routing,
          block_template: derived.block_template,
          action_auth: derived.action_auth,
        };
        if (mode === 'create') body.key = derived.key;
      } else {
        if (advancedKeyError) throw new Error(advancedKeyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset'));
        const roles = rolesCsv.split(',').map((r) => r.trim()).filter(Boolean);
        const actionAuth = humanOnly || roles.length > 0 ? { human_only: humanOnly, role: roles } : null;
        body = {
          name: name.trim(),
          payload_schema: parseJsonField(payloadSchema, t('eventPayloadSchemaLabel')),
          routing: parseJsonField(routing, t('eventRoutingLabel')),
          block_template: blockTemplate.trim() ? parseJsonField(blockTemplate, t('eventBlockTemplateLabel')) : null,
          action_auth: actionAuth,
        };
        if (mode === 'create') body.key = `${prefix}${keySuffix.trim()}`;
      }
      let res: Response;
      if (mode === 'create') {
        res = await fetchWithAuth('/api/events/definitions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        if (!target?.id) throw new Error(t('eventErrorGeneric'));
        res = await fetch(`/api/events/definitions/${target.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const resBody = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(resBody?.error?.message ?? `HTTP ${res.status}`);
      }
      // POST /api/events/definitions는 raw passthrough(proxyToFastapi, apiSuccess로 안 감쌈)라
      // BE(EventDefinitionDetailResponse)를 그대로 준다 — {data:...}가 아니다. 다만 이 계층
      // (fastapi-proxy)이 훗날 wrapped로 바뀌어도 조용히 깨지지 않게 두 형태 다 받는다
      // (오늘 세션 gate undo/discuss와 같은 방어 패턴).
      const savedRaw = await res.json().catch(() => null) as { data?: { key?: string }; key?: string } | null;
      const savedKeyValue = savedRaw?.data?.key ?? savedRaw?.key;
      addToast({ type: 'success', title: mode === 'create' ? t('eventCreateSuccessToast') : t('eventEditSuccessToast') });
      await onSaved();
      if (mode === 'create' && savedKeyValue) {
        // 다이얼로그를 안 닫는다 — 저장 즉시 테스트 발행이 가능해야 §4의 "정의→미리보기→
        // 테스트 발행" 한 흐름이 끊기지 않는다(재오픈 왕복 없음).
        setSavedKey(savedKeyValue);
      } else {
        onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof JsonFieldParseError ? t('eventJsonParseError', { field: e.field }) : e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const testPublish = async () => {
    if (!savedKey) return;
    setTestPublishing(true);
    setTestPublishResult(null);
    try {
      const derived = deriveDefinition(definerState, orgSlug);
      // PO 라이브 실측(review_changes) — 「발행할 때 지정」routing(payload_field)은 BE가
      // payload[member_id_field]에 실 멤버 id를 요구한다. 순수 파생 샘플엔 그 필드가 없어
      // 테스트 발행이 "나에게만 보내는 실 발행"(§4 약속)을 어기고 항상 실패했다 — 지금
      // 로그인한 나(currentTeamMemberId)를 여기서 채워 보낸다(파생 로직 자체는 순수 유지).
      const broadcast = derived.routing.broadcast as { kind?: string; member_id_field?: string } | undefined;
      const publishPayload = broadcast?.kind === 'payload_field' && broadcast.member_id_field && currentTeamMemberId
        ? { ...derived.samplePayload, [broadcast.member_id_field]: currentTeamMemberId }
        : derived.samplePayload;
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: savedKey, payload: publishPayload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setTestPublishResult({ ok: false, message: body?.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setTestPublishResult({ ok: true });
    } catch {
      setTestPublishResult({ ok: false, message: t('eventErrorGeneric') });
    } finally {
      setTestPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>{mode === 'create' ? t('eventCreateDialogTitle') : t('eventEditDialogTitle')}</DialogTitle>
            <div className="inline-flex shrink-0 rounded-lg bg-muted p-0.5">
              <button
                type="button"
                disabled={advancedOnly}
                onClick={() => setTab('basic')}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tab === 'basic' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                {t('definerTabBasic')}
              </button>
              <button
                type="button"
                onClick={() => setTab('advanced')}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${tab === 'advanced' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
              >
                {t('definerTabAdvanced')}
                {advancedOnly ? <Badge variant="warning" className="ml-1 text-[9px]">{t('definerAdvancedOnlyBadge')}</Badge> : null}
              </button>
            </div>
          </div>
          {/* story #2666(발견) — 원래 문구가 "org.{조직 slug}."처럼 한글 자리표시자를 ICU
              변수 자리에 그대로 박아 놔 next-intl이 MALFORMED_ARGUMENT로 파싱 실패하던
              것(콘솔 에러+깨진 렌더 — 이 다이얼로그를 열 때마다 항상 재현). ICU 유효 이름
              (slug)으로 고치고 실제 org slug를 인자로 넘긴다. */}
          {tab === 'advanced' ? <DialogDescription>{t('eventKeyPrefixHint', { slug: orgSlug || '{org}' })}</DialogDescription> : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-1">
          {/* story #3745(페드루 PO 決·유나 定 2026-09-09) — 이 필드가 화면 제목 자리에
              쓰이는 유일한 소스다(둘 다 config가 아니라 그 위 표시명이라 basic/advanced
              탭 구분과 무관 — 탭 전환에도 값이 안 사라지게 탭 조건 밖에 둔다). PATCH는
              생략을 허용하지만 이 폼은 항상 실어 보낸다(수정 폼을 열면 현재 값이 이미
              채워져 있어 "생략"할 이유가 없다 — 사람이 지우고 빈 채로 저장하면 서버가
              422로 막는다, BE 계약 그대로 클라도 재확인). */}
          <div className="mb-3">
            <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor="event-name">
              {t('eventNameLabel')}
            </label>
            <Input
              id="event-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('eventNamePlaceholder')}
              className="text-sm"
            />
            {!name.trim() ? <p className="mt-1 text-[11px] text-muted-foreground">{t('eventNameHint')}</p> : null}
          </div>
          {tab === 'basic' ? (
            <EventDefinerForm
              state={definerState}
              onChange={setDefinerState}
              orgSlug={orgSlug}
              testPublish={() => void testPublish()}
              testPublishing={testPublishing}
              testPublishResult={savedKey ? testPublishResult : { ok: false, message: t('definerTestPublishSaveFirst') }}
            />
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor="event-key">
                  {t('eventKeyLabel')}
                </label>
                {mode === 'create' ? (
                  <>
                    <div className="flex items-center gap-1">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{prefix}</span>
                      <Input id="event-key" value={keySuffix} onChange={(e) => setKeySuffix(e.target.value)} className="font-mono text-sm" />
                    </div>
                    {advancedKeyError ? (
                      <p className="mt-1 text-[11px] text-destructive">
                        {advancedKeyError === 'empty' ? t('definerKeyErrorEmpty') : t('definerKeyErrorCharset')}
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] text-muted-foreground">{t('definerKeyHint')}</p>
                    )}
                  </>
                ) : (
                  <Input id="event-key" value={target?.key ?? ''} readOnly disabled className="font-mono text-sm" />
                )}
              </div>
              <JsonField id="event-payload-schema" label={t('eventPayloadSchemaLabel')} value={payloadSchema} onChange={setPayloadSchema} />
              <JsonField id="event-routing" label={t('eventRoutingLabel')} value={routing} onChange={setRouting} />
              <JsonField id="event-block-template" label={`${t('eventBlockTemplateLabel')} (${tc('optional')})`} value={blockTemplate} onChange={setBlockTemplate} />
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={humanOnly} onChange={(e) => setHumanOnly(e.target.checked)} className="size-4" />
                  {t('eventActionAuthHumanOnlyLabel')}
                </label>
                <Input
                  value={rolesCsv}
                  onChange={(e) => setRolesCsv(e.target.value)}
                  placeholder={t('eventActionAuthRolePlaceholder')}
                  className="text-sm"
                />
              </div>
            </div>
          )}
          {error ? (
            <p role="alert" aria-live="assertive" className="mt-3 rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {mode === 'create' && savedKey ? tc('close') /* 저장 후엔 닫기만 남는다(재저장=중복 POST·409 방지) */ : tc('cancel')}
          </Button>
          {mode === 'create' && savedKey ? null : (
            <Button
              onClick={() => void submit()}
              // story #3745 — key 검증(definerKeyError/advancedKeyError)과 같은 fail-closed
              // 관례(비활성, 클릭 뒤 에러 아님) — 이름도 같은 급의 필수 필드다.
              disabled={saving || !name.trim() || (tab === 'advanced' ? mode === 'create' && !!advancedKeyError : !!definerKeyError)}
            >
              {saving ? '...' : mode === 'create' ? t('eventCreateSubmit') : t('eventEditSubmit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JsonField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );
}

function TestPublishDialog({
  target, open, onOpenChange, t, tc, addToast,
}: {
  target: EventDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  const [payload, setPayload] = useState('{}');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setPayload('{}'); setError(null); }
  }, [open]);

  const submit = async () => {
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      const parsedPayload = parseJsonField(payload, t('eventTestPublishPayloadLabel'));
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: target.key, payload: parsedPayload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      addToast({ type: 'success', title: t('eventTestPublishSuccessToast') });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof JsonFieldParseError ? t('eventJsonParseError', { field: e.field }) : e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!sending) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('eventTestPublishDialogTitle')}</DialogTitle>
          <DialogDescription>{target?.key ?? ''}</DialogDescription>
        </DialogHeader>
        <JsonField id="event-test-publish-payload" label={t('eventTestPublishPayloadLabel')} value={payload} onChange={setPayload} />
        {error ? (
          <p role="alert" aria-live="assertive" className="rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>{tc('cancel')}</Button>
          <Button onClick={() => void submit()} disabled={sending}>{sending ? '...' : t('eventTestPublishSubmit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
