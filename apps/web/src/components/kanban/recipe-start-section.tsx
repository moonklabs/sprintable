'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { extractBackendErrorMessage } from '@/lib/api-error-message';
import { fetchWithAuth } from '@/lib/db/client';
import { useRecipeStartCandidates, type RecipeStartCandidate } from '@/hooks/use-recipe-start-candidates';

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
  const t = useTranslations('board');
  const { candidates, loading, error: loadError, refresh } = useRecipeStartCandidates(projectId, 'story', storyId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

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
    return sectionShell(<p className="text-xs text-destructive">{t('recipeStartErrorGeneric')}</p>);
  }

  // AC1 — 비활성일 땐 이유(적용 안 됨 / 역할 미배정)와 가는 곳을 보여준다(막다른 길 금지).
  if (candidates.length === 0) {
    return sectionShell(
      <>
        <p className="text-xs text-muted-foreground">{t('recipeStartNotApplied')}</p>
        <Link href="/organization/events" className="mt-1 inline-block text-xs text-primary hover:underline">
          {t('recipeStartGoToApply')}
        </Link>
      </>,
    );
  }

  const active = candidates.filter((c) => c.role_bound);
  if (active.length === 0) {
    return sectionShell(
      <>
        <p className="text-xs text-muted-foreground">{t('recipeStartRoleUnassigned')}</p>
        <Link href="/organization/events" className="mt-1 inline-block text-xs text-primary hover:underline">
          {t('recipeStartGoToAssign')}
        </Link>
      </>,
    );
  }

  const selected = active.length === 1 ? active[0] : (active.find((c) => c.key === selectedKey) ?? null);

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
        const msg = extractBackendErrorMessage(body, t) ?? t('recipeStartErrorGeneric');
        throw new Error(msg);
      }
      // AC2 — 성공 시 «시작됨»이 화면에 남아야 한다. dedup 응답(deduplicated:true)도 200으로
      // 오므로 여기선 성공 분기 하나로 충분 — refresh가 started:true를 다시 읽어온다(AC6,
      // 새로고침·다른 탭과 동일 판정 경로).
      refresh();
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : t('recipeStartErrorGeneric'));
    } finally {
      setPublishing(false);
    }
  };

  return sectionShell(
    <>
      {active.length > 1 && (
        <div className="mb-2 flex flex-col gap-1">
          {active.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name={`recipe-start-${storyId}`}
                checked={selectedKey === c.key}
                onChange={() => setSelectedKey(c.key)}
              />
              {c.name}
              {c.started && <span className="text-[10px] text-muted-foreground">({t('recipeStarted')})</span>}
            </label>
          ))}
        </div>
      )}
      {selected ? (
        selected.started ? (
          selected.conversation_id ? (
            <Link
              href={`/chats/${selected.conversation_id}${selected.message_id ? `?messageId=${encodeURIComponent(selected.message_id)}` : ''}`}
              className="text-xs font-medium text-primary hover:underline"
            >
              {t('recipeStarted')} · {t('recipeStartViewConversation')}
            </Link>
          ) : (
            <p className="text-xs font-medium text-foreground">{t('recipeStarted')}</p>
          )
        ) : (
          <Button type="button" size="sm" onClick={() => void handleStart(selected)} disabled={publishing}>
            {publishing ? t('recipeStarting') : t('recipeStartButton')}
          </Button>
        )
      ) : (
        <p className="text-xs text-muted-foreground">{t('recipeStartChooseRecipe')}</p>
      )}
      {publishError && (
        <p role="alert" aria-live="assertive" className="mt-1 text-[11px] text-destructive">
          {publishError}
        </p>
      )}
    </>,
  );
}
