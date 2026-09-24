'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { extractBackendErrorMessage } from '@/lib/api-error-message';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { recipeStageLabel } from '@/lib/recipe-stage-label';
import { stageRoleLabel } from '@/lib/stage-role';
import { useRecipeStartCandidates, type RecipeStartCandidate } from '@/hooks/use-recipe-start-candidates';
import { presetName } from '@/lib/platform-preset-copy';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

// story #4082(유나 design CHANGES 2026-09-21) — recipe-stage-label.ts에 미등재된 slug는
// raw 노출 대신 「단계 n/9」로 자리표시한다(recipeStageLabel 자신의 기존 pass-through
// 계약은 detail/gallery용으로 그대로 두고, 여기 3표면만 이 wrapper로 좁힌다 — 새 기전
// 발명이 아니라 기존 두 SSOT(recipeStageLabel·stageRoleLabel)를 조합만 한다).
function displayStageLabel(
  stage: string, position: number | null, total: number | null, tOrg: (key: string) => string,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
): string {
  const label = recipeStageLabel(stage, tOrg);
  if (label !== stage) return label;
  if (position !== null && total !== null) return t('recipeStagePositionFallback', { position, total });
  return label;
}

interface RecipeStartSectionProps {
  storyId: string;
  projectId?: string;
}

// story #4075([E-RECIPE-1] «레시피 시작») AC1~AC3/AC6/AC7 — 스토리 화면의 «레시피 시작»
// 진입점. Assignee 다음·Dispatch 바로 위(페드루 확定 2026-09-21) — "킥오프=담당자 선택 후
// 액션"이라는 EntityDispatchPanel과 같은 배치 원칙(story-detail-panel.tsx L1591 주석과 동형).
// «적용 레시피»는 신규 BE 필드가 아니라 recipe_role_bindings에 행이 있는 정의(GET
// .../start-candidates, AC1/AC6) — 필터·정렬은 BE가 이미 끝낸 결과를 그대로 나열만 한다
// (2개 이상이면 고르게, 페드루 확定).
export function RecipeStartSection({ storyId, projectId }: RecipeStartSectionProps) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('board');
  // story #4082(유나 design CHANGES) — role/stage 정본 낱말표는 organization 네임스페이스
  // (recipe-detail-view.tsx가 이미 쓰는 그 SSOT, 적용 다이얼로그와 화면 간 낱말 통일).
  const tOrg = useTranslations('organization');
  const tPreset = useTranslations('recipePreset');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const { candidates, loading, error: loadError, refresh } = useRecipeStartCandidates(projectId, 'story', storyId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // story #4249 — «이 단계 완료» 확인 중인 레시피 key · 진행 중인 행동 · 오류(레시피 key별).
  const { currentTeamMemberId } = useDashboardContext();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [stageActionKey, setStageActionKey] = useState<string | null>(null);
  const [stageActionNotice, setStageActionNotice] = useState<Record<string, { tone: 'muted' | 'error'; text: string } | null>>({});
  // 넘긴 뒤 새 현재 단계가 보일 때까지 «넘겼어요» 한 줄(그 사이 버튼이 다시 뜨지 않게).
  const [advancedFrom, setAdvancedFrom] = useState<Record<string, string | null>>({});

  if (!projectId) return null;
  // story-origin-section.tsx와 동일 관례 — 로딩 중엔 깜빡임 노이즈 없이 조용히 대기.
  if (loading) return null;

  const sectionShell = (body: React.ReactNode) => (
    // story #3164 가드 — 손코딩 카드(rounded+border+card표면 bg 공존) 대신 Card 프리미티브
    // (recipe-detail-view.tsx의 surface="subtle" 관례와 동형, Dispatch 섹션의 grandfathered
    // 손코딩 div는 새로 안 따라간다).
    <Card surface="subtle" className="p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('recipeStart')}</p>
      {body}
    </Card>
  );

  if (loadError) {
    return sectionShell(<p className="break-keep text-xs text-destructive">{t('recipeStartErrorGeneric')}</p>);
  }

  // story #4075 AC1(유나 design CHANGES, 페드루 확定 2026-09-21) — 적용 레시피가 프로젝트에
  // 0개면 섹션 자체를 숨긴다(막다른 길 금지는 레시피가 실재하는데 못 시작하는 경우—역할
  // 미배정·이미 시작—에서만 지키면 충분. 레시피 0은 per-story 문제가 아니라 프로젝트 셋업
  // 관심사라 모든 스토리 패널에 뜨는 건 노이즈. 발견성은 organization/events 갤러리가 맡는다).
  if (candidates.length === 0) return null;

  const active = candidates.filter((c) => c.role_bound);
  if (active.length === 0) {
    return sectionShell(
      <>
        <p className="text-xs text-muted-foreground">{t('recipeStartRoleUnassigned')}</p>
        <Link href={flatHref('/organization/events')} className="mt-1 inline-block text-xs text-primary hover:underline">
          {t('recipeStartGoToAssign')}
        </Link>
      </>,
    );
  }

  // story #4091(유나 design 라이브 관찰 ①, 2026-09-21) — «켜면 보게» 미충족 처방: 시작된
  // 후보는 라디오 선택과 무관하게 그 자리에서 바로 진행 3줄을 보여준다. 라디오는 이제
  // «아직 안 시작한 것을 골라 시작»에만 쓰인다(started 항목은 더 고를 게 없다 — 이미
  // 진행 중). #4075 단일 후보 자동 선택 관례는 notStarted 쪽으로 그대로 옮긴다(시작
  // 前 동작 무변).
  const started = active.filter((c) => c.started);
  const notStarted = active.filter((c) => !c.started);
  const selected = notStarted.length === 1 ? notStarted[0] : (notStarted.find((c) => c.key === selectedKey) ?? null);

  const handleStart = async (candidate: RecipeStartCandidate) => {
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await fetchWithAuth('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition_key: candidate.key,
          payload: { work_item_type: 'story', work_item_id: storyId, stage: candidate.first_stage },
        }),
      });
      if (!res.ok) {
        // event-block-card.tsx::EventPublishActionButton과 동일 관례 — BE가 완성 문장을
        // 주면(allowlist/contract) 그대로, 아니면 generic 폴백.
        const body = await res.json().catch(() => null);
        // story #4261(4075 AC7 개정) — 이미 시작된 회차(두 클릭 · 두 탭 · 새로고침 재클릭 포함)는 BE가 409 RECIPE_ALREADY_STARTED로
        // 알린다. 에러가 아니라 **상태**다 — 다시 읽어 «진행 중/완료» 표시로 돌아간다(메시지는 새로 안 생겼다).
        if (res.status === 409 && isRecipeAlreadyStarted(body)) {
          refresh();
          return;
        }
        const msg = extractBackendErrorMessage(body, t) ?? t('recipeStartErrorGeneric');
        throw new Error(msg);
      }
      // AC2 — 성공(201) 시 «시작됨»이 화면에 남아야 한다 — refresh가 started:true를 다시 읽어온다(AC6, 새로고침·다른 탭과 동일
      // 판정 경로). 이미 시작된 회차(두 클릭 · 두 탭 · 새로고침 재클릭)는 story #4261부터 200 dedup이 아니라 위의 409
      // RECIPE_ALREADY_STARTED 분기가 상태로 받아 같은 refresh로 돌아간다.
      refresh();
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : t('recipeStartErrorGeneric'));
    } finally {
      setPublishing(false);
    }
  };

  // story #4249 — 사람이 자기 stage를 끝내거나(action=complete · 다음 stage를 내 명의로), 게이트 승인 뒤 다음 stage를
  // 시작한다(action=start). 서버가 지금 stage · 담당 · 승인 · 완료 방식을 다시 검증한다(화면은 보이기만 정한다 — 방식은 BE
  // 공용 판정 `current_completion`). 문안·상태 흐름은 유나 확정(스토리 4249 «디자인 확정» 절).
  const runStageAction = async (c: RecipeStartCandidate, action: 'complete' | 'start', stage: string) => {
    setStageActionKey(c.key);
    setStageActionNotice((prev) => ({ ...prev, [c.key]: null }));
    try {
      const res = await fetchWithAuth(`/api/events/definitions/${c.definition_id}/complete-stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, work_item_type: 'story', work_item_id: storyId, stage, action }),
      });
      if (res.status === 409 || res.status === 403) {
        // 상태 알림 — 구역을 스스로 다시 읽어 지난 버튼을 걷는다(«새로고침해 주세요»를 사람에게 시키지 않는다).
        setStageActionNotice((prev) => ({
          ...prev, [c.key]: { tone: 'muted', text: res.status === 409 ? t('recipeStageActionAlreadyMoved') : t('recipeStageActionNotAssignee') },
        }));
        setConfirmingKey(null);
        refresh();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(extractBackendErrorMessage(body, t) ?? t('recipeStageActionFailed'));
      }
      // 새 현재 단계가 보일 때까지 «넘겼어요» 한 줄(버튼이 다시 뜨면 두 번 발행된다).
      setAdvancedFrom((prev) => ({ ...prev, [c.key]: c.current_stage }));
      setConfirmingKey(null);
      refresh();
    } catch (e) {
      setStageActionNotice((prev) => ({
        ...prev, [c.key]: { tone: 'error', text: e instanceof Error ? e.message : t('recipeStageActionFailed') },
      }));
    } finally {
      setStageActionKey(null);
    }
  };

  const stageAction = (c: RecipeStartCandidate) => {
    if (!c.current_stage || !currentTeamMemberId) return null;
    const mine = c.current_bound_member_id === currentTeamMemberId;
    const nextMine = !!c.next_stage && c.next_bound_member_id === currentTeamMemberId;
    const busy = stageActionKey === c.key;
    const notice = stageActionNotice[c.key];
    let body: React.ReactNode = null;
    if (advancedFrom[c.key] && advancedFrom[c.key] === c.current_stage) {
      body = <p className="break-keep text-[11px] text-muted-foreground" data-testid="recipe-stage-advanced">{t('recipeCompletedStage')}</p>;
    } else if (mine && c.current_completion === 'complete' && c.next_stage) {
      const nextLabel = recipeStageLabel(c.next_stage, tOrg);
      const question = nextLabel === c.next_stage
        ? t('recipeCompleteStageConfirmUnnamed')
        : t('recipeCompleteStageConfirm', { next: nextLabel });
      body = confirmingKey === c.key ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="recipe-complete-confirm">
          <span className="break-keep text-xs text-foreground">{question}</span>
          <Button type="button" size="sm" disabled={busy} onClick={() => void runStageAction(c, 'complete', c.current_stage!)}>
            {busy ? t('recipeCompletingStage') : t('recipeCompleteStageConfirmYes')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmingKey(null)}>
            {t('recipeCompleteStageCancel')}
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" className="self-start" onClick={() => setConfirmingKey(c.key)} data-testid="recipe-complete-stage">
          {t('recipeCompleteStage')}
        </Button>
      );
    } else if (mine && c.current_completion === 'last_stage') {
      body = <p className="break-keep text-[11px] text-muted-foreground" data-testid="recipe-last-stage-hint">{t('recipeLastStageHint')}</p>;
    } else if (mine && c.current_completion === 'needs_fields') {
      body = <p className="break-keep text-[11px] text-muted-foreground" data-testid="recipe-needs-fields-hint">{t('recipeNeedsFieldsHint')}</p>;
    } else if (nextMine && c.current_completion === 'gate_approval') {
      body = c.current_gate_status === 'approved' ? (
        <Button type="button" size="sm" className="self-start" disabled={busy}
          onClick={() => void runStageAction(c, 'start', c.next_stage!)} data-testid="recipe-start-my-stage">
          {busy ? t('recipeStarting') : t('recipeStartMyStage')}
        </Button>
      ) : (
        <p className="break-keep text-[11px] text-muted-foreground" data-testid="recipe-start-my-stage-waiting">{t('recipeStartMyStageWaiting')}</p>
      );
    }
    if (!body && !notice) return null;
    return (
      <div className="mt-1 flex flex-col gap-1">
        {body}
        {notice ? (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={notice.tone === 'error' ? 'break-keep text-xs text-destructive' : 'break-keep text-[11px] text-muted-foreground'}
            data-testid="recipe-stage-action-notice"
          >
            {notice.text}
          </p>
        ) : null}
      </div>
    );
  };

  // story #4082([E-RECIPE-1] 진행 위치 표시) AC1 — «시작됨» 한 줄 대신 현재
  // 단계(역할)·다음 단계(역할, 없으면 «마지막 단계»)·마지막 발행 시각 3줄
  // («stage» 내부어 대신 정의 저자가 시드한 role 낱말을 우선 노출, 유나 낱말 표 v5.1).
  const progressLines = (c: RecipeStartCandidate) => (
    <div key={c.key} className="flex flex-col gap-1">
      {active.length > 1 && <p className="text-sm font-medium text-foreground">{presetName(c, tPreset)}</p>}
      {c.current_stage && (
        <p className="text-xs font-medium text-foreground">
          {t('recipeCurrentStageLabel')}: {displayStageLabel(c.current_stage, c.current_stage_position, c.total_stages, tOrg, t)}
          {c.current_role ? ` (${stageRoleLabel(c.current_role, tOrg)})` : ''}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {c.next_stage
          ? `${t('recipeNextStageLabel')}: ${displayStageLabel(
              c.next_stage,
              c.current_stage_position !== null ? c.current_stage_position + 1 : null,
              c.total_stages, tOrg, t,
            )}${c.next_role ? ` (${stageRoleLabel(c.next_role, tOrg)})` : ''}`
          : t('recipeNoNextStage')}
      </p>
      {c.last_published_at && (
        <p className="text-[11px] text-muted-foreground">
          {t('recipeLastPublishedLabel')}: {formatRelativeTime(c.last_published_at, locale, displayTimezone)}
        </p>
      )}
      {c.conversation_id && (
        <Link
          href={flatHref(`/chats/${c.conversation_id}${c.message_id ? `?messageId=${encodeURIComponent(c.message_id)}` : ''}`)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {t('recipeStartViewConversation')}
        </Link>
      )}
      {stageAction(c)}
    </div>
  );

  return sectionShell(
    <>
      {started.length > 0 && (
        <div className="mb-2 flex flex-col gap-3">
          {started.map((c) => progressLines(c))}
        </div>
      )}
      {notStarted.length > 1 && (
        <div className="mb-2 flex flex-col gap-1">
          {notStarted.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name={`recipe-start-${storyId}`}
                checked={selectedKey === c.key}
                onChange={() => setSelectedKey(c.key)}
                // story #4075(유나 design CHANGES) — 다크에서 브라우저 기본 accent가 뜨던
                // 것을 토큰으로(globals.css .tiptap-content 체크박스의 accent-color: var(...)
                // 관례와 동형, 여긴 Tailwind arbitrary-value 유틸).
                className="accent-[var(--primary)]"
              />
              {presetName(c, tPreset)}
            </label>
          ))}
        </div>
      )}
      {/* story #4273(유나 처방) — 시작 전 후보는 하나여도 이름을 단다(여럿일 때 라디오 라벨과 같은 presetName · 같은 text-sm). 하나면 자동
          선택돼 버튼만 남아, 바로 위 다른 레시피의 진행 줄과 붙어 «그 레시피를 다시 시작»으로 읽혔다. 버튼 문구는 그대로. */}
      {notStarted.length === 1 && (
        <p className="mb-2 text-sm text-foreground" data-testid="recipe-start-name">{presetName(notStarted[0], tPreset)}</p>
      )}
      {selected ? (
        <Button type="button" size="sm" onClick={() => void handleStart(selected)} disabled={publishing}>
          {publishing ? t('recipeStarting') : t('recipeStartButton')}
        </Button>
      ) : (
        notStarted.length > 1 && <p className="text-xs text-muted-foreground">{t('recipeStartChooseRecipe')}</p>
      )}
      {publishError && (
        <p role="alert" aria-live="assertive" className="mt-1 break-keep text-[11px] text-destructive">
          {publishError}
        </p>
      )}
    </>,
  );
}


/** story #4261 — BE 409 본문의 RECIPE_ALREADY_STARTED. 실제 봉투는 한 모양: /api/events/publish(proxyToFastapi) → BE http_exception_handler가
 * HTTPException(detail=dict)을 `{data: null, error: {code, message, …}, meta: null}`로 싼다(유나 측정). */
function isRecipeAlreadyStarted(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return (body as { error?: { code?: unknown } }).error?.code === 'RECIPE_ALREADY_STARTED';
}
