'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { Hypothesis } from '@sprintable/core-storage';
import { HypothesisStatusBadge } from '@/components/hypotheses/hypothesis-status-badge';
import { ScaleLadder } from '@/components/flow/scale-ladder';
import { UnattachedBucket } from '@/components/flow/unattached-bucket';
import { cn } from '@/lib/utils';

/**
 * story #2531(E-FLOW-V4 S1) — 축척 지도의 최상위 «지구 층». 조직 단위를 작업이 아니라
 * 가설(질문)로 올린다(doc flow-board-v4-hypothesis-scale §2). 유나 시안 f60d0502 v2 규격.
 *
 * 범위(S1) — 본체 골격만:
 * - measuring 가설만 선명(핵심 신호) · proposed는 흐림(소음 축소, opacity-60 — archived의
 *   기존 opacity 관례를 그대로 재사용) · verified/falsified/killed/archived는 이 지구층
 *   그리드에 아예 안 뜬다(«더미 미표시» — 그 서사·정반합 층은 S3~S5).
 * - fold = 연결 스토리 수만(hypothesis-row.tsx의 story_ids.length 관례 재사용). task 집계는
 *   Hypothesis 타입에 task_ids 필드 자체가 없어 스킵 — 없는 데이터를 지어내지 않는다.
 * - 드릴다운(가설→갈래 이동)은 S5(축척 전환) 몫 — 이 카드는 지금은 순수 표시.
 */

function HypothesisCard({
  hypothesis,
  dim,
  onSelect,
}: {
  hypothesis: Hypothesis;
  dim: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('flow');
  const linkedStoryCount = hypothesis.story_ids?.length ?? 0;
  const linkedEpicCount = hypothesis.epic_ids?.length ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(hypothesis.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(hypothesis.id); }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-2.5 rounded-xl border border-border bg-card p-4 text-left transition hover:border-brand/60 hover:shadow-sm',
        dim && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <HypothesisStatusBadge status={hypothesis.status} />
        {linkedEpicCount > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            {t('earthEpicCount', { n: linkedEpicCount })}
          </span>
        ) : null}
      </div>
      <p className="text-sm font-medium leading-snug text-foreground">{hypothesis.statement}</p>
      {hypothesis.metric_definition?.metric ? (
        <p className="text-[11px] text-muted-foreground">
          {t('earthMetric')} <span className="text-foreground">{hypothesis.metric_definition.metric}</span>
          {' · '}
          {t('earthTarget')} <span className="text-foreground">{hypothesis.metric_definition.target}</span>{' '}
          <span aria-hidden="true">{hypothesis.metric_definition.direction === 'up' ? '↑' : '↓'}</span>
        </p>
      ) : null}
      <div className="mt-auto flex items-center gap-1.5 border-t border-dashed border-border pt-2.5 text-[11px] text-muted-foreground">
        <span aria-hidden="true">▸</span>
        {linkedStoryCount > 0
          ? t('earthFold', { n: linkedStoryCount })
          : t('earthFoldEmpty')}
      </div>
    </div>
  );
}

/**
 * story #2530(#2930 재QA HIGH, 유나 design 규격 2026-08-09 04:22) — 결론난 가설 한 줄.
 * 전체 카드가 아니라 compact 행(질문+배지+결론 시각)만 — 접힌 섹션은 스크롤 부담 없이
 * "무엇이 결론났나"만 훑는 자리이지 지구층 카드와 같은 무게가 아니다.
 */
function ConcludedRow({
  hypothesis,
  onSelect,
  locale,
}: {
  hypothesis: Hypothesis;
  onSelect: (id: string) => void;
  locale: string;
}) {
  const t = useTranslations('flow');
  const concludedDate = new Date(hypothesis.updated_at).toLocaleDateString(locale);
  // falsified인데 이미 대체 가설(정반합)이 있으면 접힌 채로도 "낳음"이 예고돼야 한다
  // (유나 지적 — 정반합 서사가 펼쳐야만 보이면 여전히 발견성이 낮다).
  const showSupersededHint = hypothesis.status === 'falsified' && Boolean(hypothesis.superseded_by_hypothesis_id);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(hypothesis.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(hypothesis.id); }
      }}
      className="flex cursor-pointer items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/60"
    >
      <HypothesisStatusBadge status={hypothesis.status} />
      <p className="min-w-0 flex-1 truncate text-sm text-foreground">{hypothesis.statement}</p>
      {showSupersededHint ? (
        <span className="shrink-0 text-[11px] font-semibold text-info">{t('earthSupersededHint')}</span>
      ) : null}
      <span className="shrink-0 text-[11px] text-muted-foreground">{t('earthConcludedAt', { date: concludedDate })}</span>
    </div>
  );
}

export function HypothesisEarthLayer({
  projectId,
  onSelectHypothesis,
}: {
  projectId: string;
  onSelectHypothesis: (id: string) => void;
}) {
  const t = useTranslations('flow');
  const locale = useLocale();
  const [hypotheses, setHypotheses] = useState<Hypothesis[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadError(false);
    void (async () => {
      try {
        const res = await fetch(`/api/hypotheses?project_id=${projectId}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('failed');
        const json = await res.json() as { data?: Hypothesis[] };
        if (cancelled) return;
        setHypotheses(json.data ?? []);
      } catch {
        if (cancelled) return;
        setHypotheses([]);
        setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // 지구 층 = measuring(선명) + proposed(흐림)만 기본 노출. archived는 여기 그리드엔
  // 아예 안 그린다("더미 미표시").
  //
  // ⛔카디르 재QA HIGH(2026-08-09) — verified/falsified/killed("결론난 가설")도 처음엔
  // 이 필터에 걸려 지구층에서 완전히 사라졌다. measuring이던 가설이 나중에 falsified로
  // 넘어가면 카드 자체가 없어져 정반합(falsified→대체) 서사를 열 «클릭 경로»가 URL 손조작
  // 말고는 없었다 — S3의 정반합 UI가 실사용 도달 0이었던 원인. 결론난 가설은 기본 접힘
  // 섹션(카드 폭발 회피 유지)으로 아래에 남겨, 펼치면 여전히 클릭→서사 패널로 갈 수 있다.
  const measuring = hypotheses?.filter((h) => h.status === 'measuring') ?? [];
  const proposed = hypotheses?.filter((h) => h.status === 'proposed') ?? [];
  // 유나 design 규격(2026-08-09 04:22) — 최근 결론순(updated_at desc, 그 상태로 전이된
  // 가장 최근 시점 — BE가 결론 전이 시각을 별도로 안 주므로 지어내지 않고 이 필드를 쓴다).
  const concluded = (hypotheses ?? [])
    .filter((h) => h.status === 'verified' || h.status === 'falsified' || h.status === 'killed')
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  const verifiedCount = concluded.filter((h) => h.status === 'verified').length;
  const falsifiedCount = concluded.filter((h) => h.status === 'falsified').length;
  const killedCount = concluded.filter((h) => h.status === 'killed').length;

  return (
    <div className="space-y-4">
      <ScaleLadder />

      <div>
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-xs font-bold tracking-wide text-brand">{t('earthSectionLabel')}</span>
          <h2 className="text-sm font-semibold text-foreground">{t('earthSectionTitle')}</h2>
        </div>

        {hypotheses === null ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('loading')}
          </div>
        ) : loadError ? (
          <p className="py-4 text-xs text-muted-foreground">{t('earthLoadError')}</p>
        ) : measuring.length === 0 && proposed.length === 0 ? (
          // 없는 데이터에 화면 안 깎기 — 정직하게 빈 상태를 말한다(더미로 안 채움).
          <p className="py-4 text-xs text-muted-foreground">{t('earthEmpty')}</p>
        ) : (
          <div className="space-y-3">
            {measuring.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {measuring.map((h) => (
                  <HypothesisCard key={h.id} hypothesis={h} dim={false} onSelect={onSelectHypothesis} />
                ))}
              </div>
            ) : null}
            {proposed.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {proposed.map((h) => (
                  <HypothesisCard key={h.id} hypothesis={h} dim onSelect={onSelectHypothesis} />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {concluded.length > 0 ? (
        <details className="rounded-lg border border-border">
          <summary className="flex cursor-pointer items-baseline gap-2 px-3 py-2 text-xs font-semibold text-foreground">
            {t('earthConcludedHeading')}
            {/* 접힌 채로도 무엇이 결론났나 읽히는 소계 — 펼쳐야만 알 수 있으면 발견성이 낮다.
                (글리프+숫자 자체가 내용이라 aria-hidden 안 함 — AC8 색만으로 구분 금지와 같은 결) */}
            <span className="font-normal text-muted-foreground">
              {t('earthConcludedSubtotal', { verified: verifiedCount, falsified: falsifiedCount, killed: killedCount })}
            </span>
          </summary>
          <div className="divide-y divide-border border-t border-border">
            {concluded.map((h) => (
              <ConcludedRow key={h.id} hypothesis={h} onSelect={onSelectHypothesis} locale={locale} />
            ))}
          </div>
        </details>
      ) : null}

      {/* story #2534(E-FLOW-V4 S4) — 이행기. 미매달림 작업은 지구 지도(위 그리드) 안에
          안 섞고 접힌 별도 버킷으로 뺀다(지도 오염 방지, doc §7-1). */}
      <UnattachedBucket projectId={projectId} />
    </div>
  );
}
