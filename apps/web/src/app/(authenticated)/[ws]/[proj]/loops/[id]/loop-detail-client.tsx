'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { CountBadge } from '@/components/ds/count-badge';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { PageFrame } from '@/components/ds/page-frame';
import { PageSplit } from '@/components/ds/page-split';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { SummaryCard, type SummaryItem } from '@/components/ds/summary-card';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { LoopStatusBadge, type LoopStatus } from '@/components/loops/loop-status-badge';
import { LoopStageBar } from '@/components/loops/loop-stage-bar';
import { OutcomeBadge } from '@/components/loops/outcome-badge';
import { VariantGallery, type VariantGroup } from '@/components/loops/variant-gallery';
import { ContextPackPanel } from '@/components/loops/context-pack-panel';

import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';
import { useFlatHref } from '@/hooks/use-flat-href';

/** E-LOOP-LEDGER S7 loop_outcome_attribution.py::attribute_loop_outcome 산출 shape 그대로. */
interface OutcomeSnapshot {
  hypothesis_id: string;
  hypothesis_status: 'verified' | 'falsified';
  outcome_result: { metric: string; target: number; actual: number; direction: 'up' | 'down'; scored_at: string } | null;
  attributed_at: string;
}

interface Loop {
  id: string;
  project_id: string;
  parent_loop_id: string | null;
  hypothesis_id: string | null;
  brief_doc_id: string | null;
  recipe_slug: string | null;
  title: string;
  goal_tags: string[];
  status: LoopStatus;
  outcome_snapshot: OutcomeSnapshot | null;
}

interface Hypothesis {
  id: string;
  statement: string;
}

interface DocSummary {
  id: string;
  title: string;
  slug: string;
}

/**
 * loopId별 리마운트는 부모 page.tsx의 key={loopId}가 강제한다 — Next App Router가
 * 같은 [id] 템플릿 인스턴스를 소프트-nav 시 재사용해 이전 loop의 notFound/loop/hypothesis/
 * brief state가 잔존하는 버그 클래스(A3 AuditClient·S8 TenantsClient에 이은 3번째 재발
 * ·까심 QA 적출) — route param으로 fetch하는 상세 page는 항상 key-remount.
 */
export function LoopDetailClient({ loopId, wsSlug, projSlug, projectId }: { loopId: string; wsSlug: string; projSlug: string; projectId: string }) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('loops');
  const th = useTranslations('hypotheses');
  const router = useRouter();

  const [loop, setLoop] = useState<Loop | null>(null);
  const [hypothesis, setHypothesis] = useState<Hypothesis | null>(null);
  const [brief, setBrief] = useState<DocSummary | null>(null);
  const [groups, setGroups] = useState<VariantGroup[]>([]);
  const [isHuman, setIsHuman] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const loopRes = await fetchWithAuth(`/api/loops/${loopId}`);
      if (!loopRes.ok) { setNotFound(true); return; }
      const loopData = (await loopRes.json()) as Loop;
      // story f401139e — GET /api/loops/{id}가 X-Project-Id와 무관하게 200을 줄 수 있어
      // (goals/stories/conversations/sprints와 동일 계열 BE 갭, 그라운딩 확認) res.ok만으론
      // 부족 — 응답의 project_id를 현재 프로젝트와 직접 대조해야 옛 프로젝트 loop이 새
      // 프로젝트 URL 아래 노출되지 않는다.
      if (loopData.project_id && loopData.project_id !== projectId) { setNotFound(true); return; }
      setLoop(loopData);
      setNotFound(false);

      const [artifactsRes, meRes] = await Promise.all([
        fetchWithAuth(`/api/loops/${loopId}/artifacts`),
        fetchMe(),
      ]);
      if (artifactsRes.ok) setGroups((await artifactsRes.json()) as VariantGroup[]);
      if (meRes.ok) {
        const { data } = (await meRes.json()) as { data: { type: string } };
        setIsHuman(data.type === 'human');
      }

      if (loopData.hypothesis_id) {
        const hRes = await fetchWithAuth(`/api/hypotheses/${loopData.hypothesis_id}`);
        if (hRes.ok) {
          const { data } = (await hRes.json()) as { data: Hypothesis };
          setHypothesis(data);
        }
      } else {
        setHypothesis(null);
      }

      if (loopData.brief_doc_id) {
        const dRes = await fetchWithAuth(`/api/docs/${loopData.brief_doc_id}/summary`);
        if (dRes.ok) {
          const { data } = (await dRes.json()) as { data: DocSummary };
          setBrief(data);
        }
      } else {
        setBrief(null);
      }
    } catch (err) {
      console.error('[loops] 상세를 불러오지 못했습니다', err);
    } finally {
      setLoading(false);
    }
  }, [loopId, projectId]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const backToList = () => router.replace(`/${wsSlug}/${projSlug}/loops`);

  if (loading) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <PageFrame width="wide">
          <SkeletonGroup label={t('loading')} className="space-y-3">
            <Skeleton variant="text" size="title" className="max-w-sm" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-28 w-full" />
          </SkeletonGroup>
        </PageFrame>
      </>
    );
  }

  if (notFound || !loop) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <PageFrame width="wide">
          {/* story #1990: replace — 뒤로가기 재진입 트랩 방지(§3.2). */}
          <EmptyState title={t('notFound')} action={<Button variant="secondary" onClick={backToList}>{t('backToList')}</Button>} />
        </PageFrame>
      </>
    );
  }

  const canDecide = isHuman && loop.status === 'deciding';
  const totalSlots = groups.length;
  const decidedSlots = groups.filter((g) => g.artifacts.every((a) => a.decision !== 'pending')).length;
  const outcome = loop.status === 'closed' ? loop.outcome_snapshot : null;

  // 속성 칸 — «이 실행이 무엇인가»를 읽기만 하는 맥락(눌리는 것은 본문에). 값이 없는 항목은 그리지 않는다(옛 머리 줄도 그랬다).
  const railItems: SummaryItem[] = [
    { id: 'stage', label: t('filterLabel'), value: (
      <span className="flex flex-wrap items-center gap-2">
        <LoopStageBar status={loop.status} />
        <LoopStatusBadge status={loop.status} />
      </span>
    ) },
  ];
  if (totalSlots > 0) railItems.push({ id: 'decision', label: t('decisionProgressLabel'), value: t('decisionProgress', { done: decidedSlots, total: totalSlots }) });
  if (loop.recipe_slug) railItems.push({ id: 'recipe', label: t('recipeLabel'), value: <span className="font-mono text-ds-mono-lg">{loop.recipe_slug}</span> });
  if (loop.parent_loop_id) railItems.push({ id: 'lineage', label: t('lineageLabel'), value: t('lineageFrom', { id: loop.parent_loop_id.slice(0, 8) }) });
  if (brief) {
    railItems.push({ id: 'brief', label: t('briefLink'), value: (
      <Link href={flatHref(`/docs/${brief.slug}`)} className="inline-flex items-center gap-1 text-ds-action-text hover:underline">
        <Icon name="description" />
        {brief.title}
      </Link>
    ) });
  }
  // Outcome — E-LOOP-LEDGER S9: closed loop 성과(S7 outcome_snapshot 소비)
  if (outcome) {
    railItems.push({ id: 'outcome', label: t('outcomeSectionLabel'), value: (
      <span className="flex flex-col items-start gap-1">
        <OutcomeBadge hypothesisStatus={outcome.hypothesis_status} />
        {outcome.outcome_result ? (
          <span>
            {t('outcomeMetricLine', {
              metric: outcome.outcome_result.metric,
              actual: outcome.outcome_result.actual,
              dir: outcome.outcome_result.direction === 'up' ? th('dirUp') : th('dirDown'),
              target: outcome.outcome_result.target,
            })}
          </span>
        ) : (
          <span className="italic text-ds-ink-2">{t('outcomeNoResult')}</span>
        )}
      </span>
    ) });
  }
  if (loop.goal_tags.length > 0) {
    railItems.push({ id: 'tags', label: t('tagsLabel'), value: (
      <span className="flex flex-wrap gap-1">{loop.goal_tags.map((tag) => <Chip key={tag}>{tag}</Chip>)}</span>
    ) });
  }

  return (
    <>
      <TopBarSlot
        title={
          // story #1990: replace(), not push() — 콜드-진입 합성 스택에 세번째 엔트리를
          // 쌓지 않아 브라우저 BACK 재진입 트랩을 없앤다(§3.2). back()류 직접호출 금지
          // ([[feedback-history-back-nextjs]]) 준수.
          <Button variant="quiet" onClick={backToList} iconStart={<Icon name="arrow_back" />}>{t('backToList')}</Button>
        }
      />
      <PageFrame width="wide">
        <h1 className="m-0 text-ds-title font-semibold text-ds-ink">{loop.title}</h1>

        <PageSplit narrow="above" asideLabel={t('railTitle')} aside={<SummaryCard title={t('railTitle')} items={railItems} emptyLabel={t('railEmpty')} />}>
          <div className="space-y-4" data-testid="loop-detail-main">
            {/* Moat framing — decision UX = 이 화면의 심장(handoff §2) */}
            {totalSlots > 0 && loop.status === 'deciding' ? (
              <Banner tone="info"><span className="font-semibold">{t('moatFraming')}</span> — {t('moatFramingDesc')}</Banner>
            ) : null}

            {/* View-only / human-only notices */}
            {totalSlots > 0 && loop.status !== 'deciding' ? (
              <p className="m-0 text-ds-small text-ds-ink-3">{t('notDecidingNotice')}</p>
            ) : null}
            {totalSlots > 0 && loop.status === 'deciding' && !isHuman ? (
              <Banner tone="note">{t('humanOnlyNotice')}</Banner>
            ) : null}

            {/* Goal / hypothesis */}
            <Card className="p-3" data-testid="loop-goal">
              <p className="m-0 mb-1 text-ds-small text-ds-ink-3">{t('goalLabel')}</p>
              <p className="m-0 text-ds-body text-ds-ink">
                {hypothesis?.statement ?? <span className="italic text-ds-ink-2">{t('goalEmpty')}</span>}
              </p>
            </Card>

            {/* Variant gallery — 후보가 없으면 한 줄 */}
            <section aria-label={t('candidatesTitle')} className="space-y-2">
              {totalSlots > 0 ? (
                <h2 className="m-0 flex items-center gap-2 text-ds-card-title font-semibold text-ds-ink">
                  {t('candidatesTitle')}
                  <CountBadge count={totalSlots} />
                </h2>
              ) : null}
              <VariantGallery
                loopId={loop.id}
                groups={groups}
                canDecide={canDecide}
                onDecided={() => void fetchAll()}
                outcome={outcome}
              />
            </section>

            {/* Context pack — E-LOOP-LEDGER S13: "과거 loop에서 학습" (S12 계약, 브리핑 맥락 부속 섹션) — 비면 한 줄로 접혀 있다 */}
            <ContextPackPanel loopId={loop.id} />
          </div>
        </PageSplit>
      </PageFrame>
    </>
  );
}
