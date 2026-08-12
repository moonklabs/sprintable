'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RefreshCw, PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { FalsifiedClusterItem, StalledClusterItem } from './derive-attention-clusters';

// story #2541(유나 v4 SSOT f01fa94a) — 상위 2~3건만 기본 노출하고 나머지는 "전체보기"로
// 펼친다(카드 폭발 회피, hypothesis-earth-layer.tsx의 결론난 가설 <details> 관례와 같은 결).
const TOP_N = 3;

function ClusterShell({
  icon,
  title,
  subtitle,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-info/30 bg-card">
      <div className="flex items-center gap-3 bg-info/10 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info text-info-foreground" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {/* story #2420 규칙 — tint 배경 위 글자는 계열색이 아니라 text-foreground. */}
          <p className="truncate text-[11px] text-foreground">{subtitle}</p>
        </div>
        <span className="shrink-0 rounded-full border border-info/30 bg-card px-2.5 py-0.5 text-xs font-semibold text-info">
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

function ViewAllToggle({ expanded, remaining, onToggle }: { expanded: boolean; remaining: number; onToggle: () => void }) {
  const t = useTranslations('orgBriefing');
  if (!expanded && remaining <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full border-t border-border px-4 py-2.5 text-center text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {expanded ? t('clusterViewLess') : t('clusterViewAll', { n: remaining })}
    </button>
  );
}

/**
 * story #2541(#2539 스코프 ④, 유나 v4 SSOT f01fa94a) — 신호 유형별 클러스터 보드. 가설
 * 반증(최근순) + 스토리 정체(일수순) 2유형만 다룬다(agent_stuck·unanswered_blocker는 여전히
 * NowFace 플랫 리스트 몫). 두 클러스터 중 데이터가 있는 것만 렌더 — 없는 유형은 카드 자체를
 * 안 그린다(없는 데이터에 화면 안 깎기).
 */
export function AttentionClusterBoard({
  falsified,
  stalled,
}: {
  falsified: FalsifiedClusterItem[];
  stalled: StalledClusterItem[];
}) {
  const t = useTranslations('orgBriefing');
  const [falsifiedExpanded, setFalsifiedExpanded] = useState(false);
  const [stalledExpanded, setStalledExpanded] = useState(false);

  if (falsified.length === 0 && stalled.length === 0) return null;

  const shownFalsified = falsifiedExpanded ? falsified : falsified.slice(0, TOP_N);
  const shownStalled = stalledExpanded ? stalled : stalled.slice(0, TOP_N);

  return (
    <div className={cn('mb-4 grid grid-cols-1 gap-3', falsified.length > 0 && stalled.length > 0 && 'lg:grid-cols-2')}>
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
    </div>
  );
}
