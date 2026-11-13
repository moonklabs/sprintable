'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { LAYER } from '@/components/ds/layers';
import { SectionHeader } from '@/components/ds/section-header';
import { Skeleton } from '@/components/ds/skeleton';
import { cn } from '@/lib/utils';
import { OutcomeBadge } from '@/components/loops/outcome-badge';
import { AiAttributionRow, AiTransparencyLine, type AiConfidence } from '@/components/loops/ai-attribution';
import { fetchWithAuth } from '@/lib/db/client';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';
import { SLOW_JOB_NOTICE_MS, asQueuedJob, waitForBackgroundJob } from '@/lib/background-job';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

/** E-LOOP-LEDGER S13 — GET /loops/{id}/context-pack 응답 shape(handoff §3, PO-locked). */
interface ContextPackDecision {
  /** S12 Pydantic 실스키마 확인(까심 QA): loop에 chosen 아티팩트가 아직 없으면(결정 진행 중)
   * decision 객체는 non-null이지만 chosen만 null일 수 있다 — rejected만 있거나 둘 다 빈 경우도 유효. */
  chosen: { label: string; reason: string } | null;
  rejected: { label: string; reason: string }[];
}
interface ContextPackOutcome {
  hypothesis_status: 'verified' | 'falsified';
  metric: string;
  actual: number;
  target: number;
  direction: 'up' | 'down';
}
interface ContextPackItem {
  entity_type: 'loop' | 'hypothesis' | 'decision';
  entity_id: string;
  similarity: number;
  goal: string;
  decision: ContextPackDecision | null;
  outcome: ContextPackOutcome | null;
  /** hypothesis entity는 FE에 독립 라우트가 없어 BE가 null 반환(방어) — 링크 생략, broken 링크 대신 정직 null. */
  href: string | null;
}
interface ContextPackResponse {
  items: ContextPackItem[];
  embed_available: boolean;
  /**
   * E-LOOP-LEDGER S26 — gen-LLM이 회수 precedents를 증류한 학습 요약(#1843, PO-locked 계약).
   * optional: 디디 BE 미착지 과도기·gen-LLM 미가용·items 0건 등은 null — 섹션 자체를 렌더 생략(null-safe).
   */
  synthesis?: string | null;
  /**
   * E-LOOP-LEDGER S27 — gen-LLM 능동 추천(L3, #1845, PO-locked 계약). optional·null-safe: BE 미착지/
   * gen-LLM 미가용/근거 부족 등은 null — 섹션 생략(퇴화 없음, S26과 동일 원칙).
   * ⭐유나 LOCK: 제안형 톤(복리 엔진은 결정을 돕지 대체 안 함)·시각 위계는 결정 UI보다 항상 낮게(subtle).
   */
  recommendation?: string | null;
  /**
   * E-LOOP-LEDGER S28 — voice/attribution 계약(실 BE #1854, `schemas/context_pack.py` 확인).
   * *_confidence(LLM 산출·gen-LLM 호출별 독립)는 synthesis/recommendation 각각 분리 필드가 맞지만,
   * evidence_count는 LLM 산출물이 아니라 **items 수로 결정론적 산출되는 단일 공유 필드**(까심 RC —
   * FE가 초기에 synthesis_evidence_count/recommendation_evidence_count로 분리 가정했던 것을 실 BE
   * shape로 수정, 크로스모델 계약 불일치 교정). optional·null-safe: BE 미착지 시 칩만 뜨고 배지 생략.
   */
  synthesis_confidence?: AiConfidence | null;
  recommendation_confidence?: AiConfidence | null;
  evidence_count?: number | null;
}

function ContextPackCard({ item }: { item: ContextPackItem }) {
  const t = useTranslations('loops');
  const entityLabel = t(`entityType${item.entity_type.charAt(0).toUpperCase()}${item.entity_type.slice(1)}` as 'entityTypeLoop');
  const viewLabel = item.entity_type === 'hypothesis' ? t('contextPackViewHypothesis') : t('contextPackViewLoop');

  return (
    // 면: 글 줄 층(rowOthers) — 안쪽 결정 칸은 내용 칸(panel)으로 한 단 올려 가른다.
    <div className={cn('space-y-2.5 rounded-ds-control border border-ds-line p-3', LAYER.rowOthers)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip className="uppercase">{entityLabel}</Chip>
            {item.outcome ? <OutcomeBadge hypothesisStatus={item.outcome.hypothesis_status} /> : null}
          </div>
          <p className="m-0 text-ds-body font-semibold text-ds-ink">{item.goal}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="whitespace-nowrap font-mono text-ds-mono-md text-ds-ink-2">
            {t('contextPackSimilarity', { value: item.similarity.toFixed(2) })}
          </span>
          <div className="h-1 w-16 overflow-hidden rounded-full bg-ds-info-soft" aria-hidden>
            <div className="h-full rounded-full bg-ds-info" style={{ width: `${Math.round(item.similarity * 100)}%` }} />
          </div>
        </div>
      </div>

      {item.decision ? (
        <div className={cn('space-y-1 rounded-ds-control border border-ds-line p-2.5 text-ds-small', LAYER.panel)}>
          {item.decision.chosen ? (
            <div>
              <Chip tone="done" icon="check" className="mr-1.5">{t('contextPackChosenLabel')}</Chip>
              <span className="font-medium text-ds-ink">{item.decision.chosen.label}</span>
              <span className="text-ds-ink-2"> — {item.decision.chosen.reason}</span>
            </div>
          ) : (
            <p className="m-0 italic text-ds-ink-2">{t('contextPackDecisionPending')}</p>
          )}
          {item.decision.rejected.map((r, i) => (
            <div key={i}>
              <Chip className="mr-1.5">{t('contextPackRejectedLabel')}</Chip>
              <span className="font-medium text-ds-ink">{r.label}</span>
              <span className="text-ds-ink-2"> — {r.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-ds-line pt-2 text-ds-small text-ds-ink-2">
        {item.outcome ? (
          <span>
            {t('contextPackOutcomeLine', {
              metric: item.outcome.metric,
              actual: item.outcome.actual,
              arrow: item.outcome.direction === 'up' ? '↑' : '↓',
              target: item.outcome.target,
            })}
          </span>
        ) : <span />}
        {item.href ? (
          <Link href={item.href} className="shrink-0 font-semibold text-ds-action-text hover:underline">
            {viewLabel} →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * S13 — "과거 loop에서 학습" 패널. loop 상세/brief 뷰 부속 섹션(handoff §1).
 * S12(GET /loops/{id}/context-pack) 착지 전이라도 계약 shape은 PO-locked(목업이 정의) —
 * BFF는 이미 준비돼 있어 S12 머지되면 이 컴포넌트는 변경 없이 라이브 연결된다.
 */
export function ContextPackPanel({ loopId }: { loopId: string }) {
  const t = useTranslations('loops');
  const tCommon = useTranslations('common');
  const { orgId } = useDashboardContext();
  const [data, setData] = useState<ContextPackResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [slow, setSlow] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setUnavailable(false);
    setSlow(false);
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/loops/${loopId}/context-pack`, { timeoutMs: LONG_ROUTES.loopContextPack.browserMs });
        if (cancelled) return;
        if (!res.ok) { setUnavailable(true); return; }
        const json = (await res.json()) as unknown;
        // story #4336 PR2 ②(PO 04:32Z) — 종합/추천 캐시 미스면 BE가 202 + 작업(loop_context_pack). 워커가 만들 때까지 스켈레톤을 두고 기다린다
        // (10초 넘으면 «창을 닫아도 계속 처리돼요») — 워커가 캐시를 채워 다음 방문은 곧바로 온다.
        const queued = asQueuedJob(json, 'loop_context_pack');
        if (!queued) { setData(json as ContextPackResponse); return; }
        if (!orgId) { setUnavailable(true); return; }
        slowTimer = setTimeout(() => { if (!cancelled) setSlow(true); }, SLOW_JOB_NOTICE_MS);
        const finished = await waitForBackgroundJob<{ pack?: ContextPackResponse }>(orgId, queued.id, { signal: controller.signal });
        if (cancelled || finished === null) return;
        const pack = finished.status === 'completed' ? finished.result?.pack : undefined;
        if (pack) setData(pack); else setUnavailable(true);
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        clearTimeout(slowTimer);
        if (!cancelled) { setLoading(false); setSlow(false); }
      }
    })();
    return () => { cancelled = true; controller.abort(); clearTimeout(slowTimer); };
  }, [loopId, orgId]);

  const hasItems = !loading && !unavailable && !!data && data.embed_available && data.items.length > 0;
  // 비었거나 못 가져온 «과거 학습»은 큰 빈 칸이 아니라 한 줄로 접혀 있다(4911) — 사람이 펼치면 그 안내가 열린다. 있으면 펼쳐 있다.
  const collapsed = userCollapsed ?? (!loading && !hasItems);
  const summary = loading ? null
    : unavailable || (data && !data.embed_available) ? t('contextPackEmbedUnavailable')
      : !data || data.items.length === 0 ? t('contextPackEmpty')
        : t('contextPackCount', { count: data.items.length });

  return (
    <Card className="overflow-hidden" data-slot="context-pack" data-collapsed={collapsed}>
      <SectionHeader
        title={t('contextPackTitle')}
        level={3}
        collapsed={collapsed}
        onToggle={() => { if (!loading) setUserCollapsed(!collapsed); }}
      />
      {summary ? <p data-testid="context-pack-summary" className="m-0 border-b border-ds-line px-4 py-1.5 break-keep text-ds-small text-ds-ink-2">{summary}</p> : null}
      {collapsed ? null : (
        <div className="border-t-0">
          <p className="m-0 border-b border-ds-line px-4 py-2 break-keep text-ds-small text-ds-ink-3">{t('contextPackSubtitle')}</p>
          <div className="space-y-2.5 p-3">
            {loading ? (
              <>
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                {slow ? <p className="m-0 break-keep text-center text-ds-small text-ds-ink-3">{tCommon('backgroundJobSlow')}</p> : null}
              </>
            ) : unavailable || (data && !data.embed_available) ? (
              <p className="m-0 py-4 text-center text-ds-body text-ds-ink-3">{t('contextPackEmbedUnavailable')}</p>
            ) : !data || data.items.length === 0 ? (
              <p className="m-0 py-4 text-center text-ds-body text-ds-ink-3">{t('contextPackEmpty')}</p>
            ) : (
              <>
                {/* L2 요약(위) → L3 제안(중간) → L1 근거 items(아래) — 유나 LOCK: 위계는 항상 결정 UI보다 낮게. */}
                {data.synthesis ? (
                  <div className="rounded-ds-control border border-ds-info/40 bg-ds-info-soft p-2.5 text-ds-small text-ds-ink">
                    <div className="flex items-start gap-2">
                      <Icon name="auto_awesome" className="mt-0.5 text-ds-info" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <p className="m-0 font-semibold">{t('contextPackSynthesisTitle')}</p>
                          <AiAttributionRow confidence={data.synthesis_confidence} evidenceCount={data.evidence_count} />
                        </div>
                        <p className="m-0 whitespace-pre-line text-ds-ink">{data.synthesis}</p>
                      </div>
                    </div>
                    <AiTransparencyLine className="border-ds-info/40" />
                  </div>
                ) : null}
                {data.recommendation ? (
                  <div className={cn('rounded-ds-control border border-dashed border-ds-line-control p-2.5 text-ds-small text-ds-ink-2', LAYER.rowOthers)}>
                    <div className="flex items-start gap-2">
                      <Icon name="lightbulb" className="mt-0.5" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <p className="m-0 font-medium text-ds-ink">{t('contextPackRecommendationTitle')}</p>
                          <AiAttributionRow confidence={data.recommendation_confidence} evidenceCount={data.evidence_count} />
                        </div>
                        <p className="m-0 whitespace-pre-line">{data.recommendation}</p>
                      </div>
                    </div>
                    <AiTransparencyLine />
                  </div>
                ) : null}
                {data.items.map((item) => <ContextPackCard key={`${item.entity_type}-${item.entity_id}`} item={item} />)}
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
