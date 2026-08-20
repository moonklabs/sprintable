'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RefreshCw, PauseCircle, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { FalsifiedClusterItem, StalledClusterItem, LoopClusterItem } from './derive-attention-clusters';

// story #2541(유나 v4 SSOT f01fa94a) — 상위 2~3건만 기본 노출하고 나머지는 "전체보기"로
// 펼친다(카드 폭발 회피, hypothesis-earth-layer.tsx의 결론난 가설 <details> 관례와 같은 결).
const TOP_N = 3;

// story #2830(유나 스티어①) — 이 클러스터는 "방치" attention 신호이지 실패가 아니다.
// destructive(빨강) 금지 — info/warning 2톤만 쓴다(계열은 border/bg로 전하고 글자는
// 항상 text-foreground, story #2420 v3 규칙).
type ClusterTone = 'info' | 'warning';
const TONE_CLASS: Record<ClusterTone, { border: string; headerBg: string; iconBg: string; countBorder: string }> = {
  info: { border: 'border-info/30', headerBg: 'bg-info/10', iconBg: 'bg-info text-info-foreground', countBorder: 'border-info/30' },
  warning: { border: 'border-warning-border', headerBg: 'bg-warning-tint', iconBg: 'bg-warning text-foreground', countBorder: 'border-warning-border' },
};

function ClusterShell({
  tone = 'info',
  icon,
  title,
  subtitle,
  count,
  children,
}: {
  tone?: ClusterTone;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  children: React.ReactNode;
}) {
  const c = TONE_CLASS[tone];
  return (
    <div className={cn('overflow-hidden rounded-2xl border bg-card', c.border)}>
      <div className={cn('flex items-center gap-3 px-4 py-3', c.headerBg)}>
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', c.iconBg)} aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {/* story #2420 규칙 — tint 배경 위 글자는 계열색이 아니라 text-foreground. */}
          <p className="truncate text-[11px] text-foreground">{subtitle}</p>
        </div>
        <span className={cn('shrink-0 rounded-full border bg-card px-2.5 py-0.5 text-xs font-semibold text-foreground', c.countBorder)}>
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function FalsifiedRow({ item }: { item: FalsifiedClusterItem }) {
  const t = useTranslations('orgBriefing');
  return (
    <Link
      href={item.href}
      className="block border-t border-border px-4 py-3 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.title}</p>
        <Badge variant="info" className="shrink-0">{t('clusterFalsifiedBadge')}</Badge>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {/* 유나 design:changes(2026-08-12, PR#2940 비차단 권장) — 목표→최종 값 위계가 목업
            대비 flat했다. 최종값만 bold/text-foreground로 올려 결과가 눈에 먼저 들어오게 한다. */}
        {item.hasOutcome
          ? t.rich('clusterFalsifiedResult', {
              target: item.target ?? 0,
              actual: item.actual ?? 0,
              b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
            })
          : t('clusterFalsifiedResultUnknown')}
      </p>
      <div className="mt-2 flex items-baseline gap-1.5 rounded-lg bg-info/10 px-2.5 py-1.5">
        {/* story #2420 규칙 — tint 배경 위 글자는 계열색이 아니라 text-foreground. */}
        <span className="shrink-0 text-[11px] font-semibold text-foreground">{t('clusterBegetLabel')}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
          {item.supersededId ? t('clusterBegetLinked') : t('clusterBegetUnlinked')}
        </span>
      </div>
      <p className="mt-1.5 text-right text-[11.5px] font-medium text-primary">{t('clusterOpenNarrative')}</p>
    </Link>
  );
}

function StalledRow({ item }: { item: StalledClusterItem }) {
  const t = useTranslations('orgBriefing');
  return (
    <Link
      href={item.href}
      className="flex items-center gap-2.5 border-t border-border px-4 py-2.5 transition-colors hover:bg-muted/50"
    >
      <p className="min-w-0 flex-1 truncate text-sm text-foreground">{item.title}</p>
      {/* story #2420 규칙 — tint 배경 위 글자는 계열색이 아니라 text-foreground. */}
      {item.days !== null ? (
        <span className="shrink-0 rounded-md bg-info/10 px-2 py-0.5 text-[11px] font-semibold text-foreground">
          {t('clusterStalledDays', { n: item.days })}
        </span>
      ) : null}
      <span className="shrink-0 text-[11.5px] font-medium text-primary">{t('clusterStalledOpen')}</span>
    </Link>
  );
}

const LOOP_KIND_BADGE_KEY: Record<LoopClusterItem['kind'], string> = {
  overdueHypothesis: 'clusterUnclosedBadgeOverdueHypothesis',
  overdueGoal: 'clusterUnclosedBadgeOverdueGoal',
  outcomeMissing: 'clusterUnclosedBadgeOutcomeMissing',
};
const LOOP_KIND_DAYS_KEY: Record<LoopClusterItem['kind'], string> = {
  overdueHypothesis: 'clusterUnclosedDaysOverdue',
  overdueGoal: 'clusterUnclosedDaysOverdue',
  outcomeMissing: 'clusterUnclosedDaysDone',
};

// story #2830(유나 스티어③) — 행 클릭이 «실제 outcome 판정 UI»(item.href = /flow?goal=·
// /flow?hypothesis=)에 닿는다 — 그냥 보드 도착이 아니라 판정 행동까지 한 클릭.
function LoopRow({ item }: { item: LoopClusterItem }) {
  const t = useTranslations('orgBriefing');
  return (
    <Link
      href={item.href}
      className="flex items-center gap-2.5 border-t border-border px-4 py-2.5 transition-colors hover:bg-muted/50"
    >
      <p className="min-w-0 flex-1 truncate text-sm text-foreground">{item.title}</p>
      <Badge variant="warning" className="shrink-0">{t(LOOP_KIND_BADGE_KEY[item.kind])}</Badge>
      {item.days !== null ? (
        <span className="shrink-0 rounded-md bg-warning-tint px-2 py-0.5 text-[11px] font-semibold text-foreground">
          {t(LOOP_KIND_DAYS_KEY[item.kind], { n: item.days })}
        </span>
      ) : null}
    </Link>
  );
}

// story #2830(유나 스티어②) — items[]가 BE top-20 cap이라(doc a8e73bdb §3) "전체보기"가 실제
// 전체를 못 담을 수 있다. no-silent-cap 원칙상 이 경우 일반 ViewAllToggle("전체보기")을 쓰지
// 않고 정직한 문구로 잘림을 명시한다 — 거짓 "전체"를 암시하지 않는다.
function LoopCapNotice({ shown, total }: { shown: number; total: number }) {
  const t = useTranslations('orgBriefing');
  if (shown >= total) return null;
  return (
    <p className="border-t border-border px-4 py-2.5 text-center text-[11px] text-muted-foreground">
      {t('clusterUnclosedCapNotice', { shown, total })}
    </p>
  );
}

// story #2830(§2 PO 보완 지시) — N 비포함·집계만 유지되는 3번째 카테고리(측정계획 없는 active
// goal). 개별 목록·클릭 링크 없음(AC상 요건 없음), 카드 하단 옅은 보조 텍스트 한 줄로만 존재를
// 알린다. 유나 스티어④ — "옅게"가 AA 밑으로 못 내려간다: text-muted-foreground(3.x대, AA 미달
// 가능성)가 아니라 text-foreground 소형(11px)으로 대비는 지키되 크기/톤으로 옅음을 표현한다.
function MeasurePlanMissingNote({ count }: { count: number }) {
  const t = useTranslations('orgBriefing');
  if (count <= 0) return null;
  return (
    <p className="border-t border-border bg-muted/30 px-4 py-2 text-[11px] text-foreground">
      {t('clusterUnclosedMeasurePlanMissing', { count })}
    </p>
  );
}

function ViewAllToggle({
  expanded,
  remaining,
  onToggle,
  // story #2830 — loop 클러스터는 items[]가 top-20 cap이라 "전체보기"(clusterViewAll)로
  // 거짓 전체를 암시하면 안 된다. 호출부가 명시적으로 "더보기"류 키를 넘긴다(기본값은 기존
  // falsified/stalled 그대로 무회귀).
  expandLabelKey = 'clusterViewAll',
}: { expanded: boolean; remaining: number; onToggle: () => void; expandLabelKey?: string }) {
  const t = useTranslations('orgBriefing');
  if (!expanded && remaining <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full border-t border-border px-4 py-2.5 text-center text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {expanded ? t('clusterViewLess') : t(expandLabelKey, { n: remaining })}
    </button>
  );
}

/**
 * story #2541(#2539 스코프 ④, 유나 v4 SSOT f01fa94a) — 신호 유형별 클러스터 보드. 가설
 * 반증(최근순) + 스토리 정체(일수순) + story #2830 「닫힌 적 없는 루프」 3유형(agent_stuck·
 * unanswered_blocker는 여전히 NowFace 플랫 리스트 몫). 데이터가 있는 클러스터만 렌더 —
 * 없는 유형은 카드 자체를 안 그린다(없는 데이터에 화면 안 깎기, N=0이면 배경음 방지).
 */
export function AttentionClusterBoard({
  falsified,
  stalled,
  loop,
  loopTotalCount,
  measurePlanMissingGoalCount,
}: {
  falsified: FalsifiedClusterItem[];
  stalled: StalledClusterItem[];
  loop: LoopClusterItem[];
  loopTotalCount: number;
  measurePlanMissingGoalCount: number;
}) {
  const t = useTranslations('orgBriefing');
  const [falsifiedExpanded, setFalsifiedExpanded] = useState(false);
  const [stalledExpanded, setStalledExpanded] = useState(false);
  const [loopExpanded, setLoopExpanded] = useState(false);

  const hasLoop = loopTotalCount > 0;
  if (falsified.length === 0 && stalled.length === 0 && !hasLoop) return null;

  const shownFalsified = falsifiedExpanded ? falsified : falsified.slice(0, TOP_N);
  const shownStalled = stalledExpanded ? stalled : stalled.slice(0, TOP_N);
  const shownLoop = loopExpanded ? loop : loop.slice(0, TOP_N);
  const visibleCount = [falsified.length > 0, stalled.length > 0, hasLoop].filter(Boolean).length;

  return (
    <div
      className={cn(
        'mb-4 grid grid-cols-1 gap-3',
        visibleCount === 2 && 'lg:grid-cols-2',
        visibleCount === 3 && 'lg:grid-cols-2 xl:grid-cols-3',
      )}
    >
      {falsified.length > 0 ? (
        <ClusterShell
          icon={<RefreshCw className="size-4" aria-hidden="true" />}
          title={t('clusterFalsifiedTitle')}
          subtitle={t('clusterFalsifiedSub')}
          count={falsified.length}
        >
          {shownFalsified.map((item) => <FalsifiedRow key={item.id} item={item} />)}
          <ViewAllToggle
            expanded={falsifiedExpanded}
            remaining={falsified.length - TOP_N}
            onToggle={() => setFalsifiedExpanded((v) => !v)}
          />
        </ClusterShell>
      ) : null}
      {stalled.length > 0 ? (
        <ClusterShell
          icon={<PauseCircle className="size-4" aria-hidden="true" />}
          title={t('clusterStalledTitle')}
          subtitle={t('clusterStalledSub')}
          count={stalled.length}
        >
          {shownStalled.map((item) => <StalledRow key={item.id} item={item} />)}
          <ViewAllToggle
            expanded={stalledExpanded}
            remaining={stalled.length - TOP_N}
            onToggle={() => setStalledExpanded((v) => !v)}
          />
        </ClusterShell>
      ) : null}
      {hasLoop ? (
        <ClusterShell
          tone="warning"
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          title={t('clusterUnclosedTitle')}
          subtitle={t('clusterUnclosedSub')}
          count={loopTotalCount}
        >
          {shownLoop.map((item) => <LoopRow key={item.id} item={item} />)}
          <ViewAllToggle
            expanded={loopExpanded}
            remaining={loop.length - TOP_N}
            onToggle={() => setLoopExpanded((v) => !v)}
            expandLabelKey="clusterUnclosedShowMore"
          />
          {/* no-silent-cap(유나 스티어②) — 다 펼쳤어도 items[]가 top-20 cap이면 실제 총량과
              다를 수 있다는 것을 정직하게 알린다. */}
          {loopExpanded ? <LoopCapNotice shown={loop.length} total={loopTotalCount} /> : null}
          <MeasurePlanMissingNote count={measurePlanMissingGoalCount} />
        </ClusterShell>
      ) : null}
    </div>
  );
}
