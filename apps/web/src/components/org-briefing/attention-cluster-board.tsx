'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RefreshCw, AlertTriangle, FolderOpen, KeyRound, ChevronDown, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AuthFailureClusterItem, AuthFailureReason, FalsifiedClusterItem, LoopClusterItem } from './derive-attention-clusters';
import type { SilentStallBucket, SilentStallBucketKey } from './derive-silent-stall-clusters';

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
  // story #93b076c8(2250) FE 델타 — 유나 발주서 "최장 배지"(예: 「1개월+ 16건」) 충족용
  // additive 슬롯. 기존 4개 tone 소비자는 안 넘기므로(undefined) 헤더 모양·동작 무변경
  // (회귀 0) — 이 prop이 있을 때만 count 배지 옆에 두 번째 배지가 선다.
  extraBadge,
  children,
}: {
  tone?: ClusterTone;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  extraBadge?: React.ReactNode;
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
        {extraBadge}
        <span className={cn('shrink-0 rounded-full border bg-card px-2.5 py-0.5 text-xs font-semibold text-foreground', c.countBorder)}>
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

// story #2842(0b17472c 그라운딩, PO 확定) — 항목이 뷰어의 활성 프로젝트와 다른 프로젝트
// 소속일 때만 병기(같으면 null이라 이 컴포넌트 자체가 안 그려짐 — 노이즈 절제). 병기 값은
// BE가 주는 project_slug 그대로(별도 표시용 프로젝트명 필드는 이 계약에 없음).
// story #2858 — loop-queue-client.tsx도 이 컴포넌트를 그대로 재사용한다(export). 페드루 PO
// 판정(2026-08-21, 2851 교훈 적용) — 별개 페이지라도 표시 컴포넌트는 단일 정의를 유지한다
// (로컬 재정의는 중복 정의 규율 위반).
export function CrossProjectTag({ label }: { label: string | null }) {
  if (!label) return null;
  return <Badge variant="chip" className="shrink-0 gap-1"><FolderOpen className="size-3 shrink-0" aria-hidden />{label}</Badge>;
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
        <CrossProjectTag label={item.crossProjectLabel} />
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
      <CrossProjectTag label={item.crossProjectLabel} />
      <Badge variant="warning" className="shrink-0">{t(LOOP_KIND_BADGE_KEY[item.kind])}</Badge>
      {item.days !== null ? (
        <span className="shrink-0 rounded-md bg-warning-tint px-2 py-0.5 text-[11px] font-semibold text-foreground">
          {t(LOOP_KIND_DAYS_KEY[item.kind], { n: item.days })}
        </span>
      ) : null}
    </Link>
  );
}

// story #2852(2836 FE 조각) AC3 — reason enum을 화면에 그대로 노출하지 않고 유저 어휘로
// 매핑한다. invalid는 org-스코프 attention엔 실질적으로 안 뜨지만(org_id NULL이라 귀속
// 불가) 방어적으로 매핑해 둔다.
const AUTH_FAILURE_REASON_KEY: Record<AuthFailureReason, string> = {
  expired: 'clusterAuthFailureReasonExpired',
  revoked: 'clusterAuthFailureReasonRevoked',
  invalid: 'clusterAuthFailureReasonInvalid',
};

// story #2852 AC1 — 인증 실패는 「복구 가능한 주의 요망 상태」(키 재발급으로 복구)이지
// kill/종결 이벤트가 아니다. BE severity:"danger"를 시각으로 직결하지 않고 loop 클러스터와
// 동형 warning 톤을 쓴다. AC3 — 「키 재발급」 행동 경로(에이전트 상세 페이지, AgentApiKeyManager
// 위치)를 제공해 긴급성을 색이 아니라 행동 어포던스로 전한다.
function AuthFailureRow({ item, memberNames }: { item: AuthFailureClusterItem; memberNames: Record<string, string> }) {
  const t = useTranslations('orgBriefing');
  const name = (item.memberId && memberNames[item.memberId]) || t('clusterAuthFailureUnknownAgent');
  return (
    <div className="flex items-center gap-2.5 border-t border-border px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{name}</p>
        <p className="truncate text-[11px] text-foreground">
          {t(AUTH_FAILURE_REASON_KEY[item.reason])} · {t('clusterAuthFailureDiagnostic', { n: item.failureCount })}
        </p>
      </div>
      {item.memberId ? (
        <Link
          href={`/organization/workforce/${item.memberId}`}
          className="shrink-0 rounded-md bg-warning-tint px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:brightness-95"
        >
          <span className="inline-flex items-center gap-1"><KeyRound className="size-3" aria-hidden />{t('clusterAuthFailureReissue')}</span>
        </Link>
      ) : null}
    </div>
  );
}

// story #2830(유나 스티어②) — items[]가 BE top-20 cap이라(doc a8e73bdb §3) "전체보기"가 실제
// 전체를 못 담을 수 있다. no-silent-cap 원칙상 이 경우 일반 ViewAllToggle("전체보기")을 쓰지
// 않고 정직한 문구로 잘림을 명시한다 — 거짓 "전체"를 암시하지 않는다.
// story #2858(loop-closure P2) — 잘림 고지 옆에 «전부» 볼 수 있는 실제 경로(전량 페이지네이션
// 큐)를 바로 붙인다. 문구만 정직하고 갈 곳이 없으면 그 정직함이 막다른 길이다.
function LoopCapNotice({ shown, total }: { shown: number; total: number }) {
  const t = useTranslations('orgBriefing');
  if (shown >= total) return null;
  return (
    <p className="border-t border-border px-4 py-2.5 text-center text-[11px] text-muted-foreground">
      {t('clusterUnclosedCapNotice', { shown, total })}{' '}
      <Link href="/loop-queue" className="font-medium text-primary hover:underline">
        {t('clusterUnclosedViewQueue')}
      </Link>
    </p>
  );
}

// story #93b076c8(2250) FE — doc `silence-stall-display-spec-93b076c8`(유나 확定 규격).
// 구간별 무게 escalation(muted→warning→warning-strong, 빨강 금지 — 정체는 주의이지 kill/
// 실패가 아니다). 색은 그래픽(border-l·바)에만 싣고 글자는 계열색 배지에서만 warning-strong
// 사용(text-foreground와 병행 — 색 단독 의존 금지, doc §"색·대비 규율").
const BUCKET_STYLE: Record<SilentStallBucketKey, { borderL: string; count: string; bar: string; rowBg?: string }> = {
  '48h-1w': { borderL: 'border-l-2 border-l-border', count: 'text-muted-foreground', bar: 'bg-muted-foreground/40' },
  '1w-2w': { borderL: 'border-l-2 border-l-warning/50', count: 'text-warning-strong', bar: 'bg-warning/50' },
  '2w-1mo': { borderL: 'border-l-[3px] border-l-warning', count: 'text-warning-strong', bar: 'bg-warning' },
  '1mo+': {
    borderL: 'border-l-[3px] border-l-warning-strong', count: 'text-warning-strong', bar: 'bg-warning-strong',
    rowBg: 'bg-warning-tint/40',
  },
};
const BUCKET_LABEL_KEY: Record<SilentStallBucketKey, string> = {
  '48h-1w': 'clusterSilentStallBucket48hTo1w',
  '1w-2w': 'clusterSilentStallBucket1wTo2w',
  '2w-1mo': 'clusterSilentStallBucket2wTo1mo',
  '1mo+': 'clusterSilentStallBucket1moPlus',
};

function ageDaysLabel(t: ReturnType<typeof useTranslations>, ageHours: number): string {
  return t('clusterSilentStallAgeDays', { n: Math.floor(ageHours / 24) });
}

function SilentStallExpandedRow({
  item, memberNames, t,
}: {
  item: { id: string; title: string; ageHours: number; assigneeMemberId: string | null; href: string };
  memberNames: Record<string, string>;
  t: ReturnType<typeof useTranslations>;
}) {
  const owner = (item.assigneeMemberId && memberNames[item.assigneeMemberId]) || t('clusterSilentStallUnassigned');
  return (
    <Link
      href={item.href}
      className="flex items-center gap-2.5 border-t border-border/60 px-4 py-2 transition-colors hover:bg-muted/50"
    >
      <span className="w-12 shrink-0 font-mono text-xs text-warning-strong">{ageDaysLabel(t, item.ageHours)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{item.title}</span>
      <span className="shrink-0 truncate text-[10.5px] text-muted-foreground">{owner}</span>
    </Link>
  );
}

// story #93b076c8 — 접힘 행 1개(구간 요약: 건수·라벨·비율바·chevron). 클릭=펼침(기본 접힘).
// 비율바는 4구간 중 최대 건수 대비(0건이면 렌더 자체를 안 함 — 빈 구간은 행이 없다, AC7
// "0건일 때의 의미" 원칙과 동형: 없는 구간을 굳이 «0»으로 그리지 않는다).
function SilentStallBucketRow({
  bucket, maxCount, expanded, onToggle, memberNames, t,
}: {
  bucket: SilentStallBucket;
  maxCount: number;
  expanded: boolean;
  onToggle: () => void;
  memberNames: Record<string, string>;
  t: ReturnType<typeof useTranslations>;
}) {
  if (bucket.items.length === 0) return null;
  const style = BUCKET_STYLE[bucket.key];
  const barPct = maxCount > 0 ? Math.max(4, Math.round((bucket.items.length / maxCount) * 100)) : 0;
  return (
    <div className={cn('border-t border-border', style.rowBg)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn('flex w-full items-center gap-3 py-2.5 pl-3 pr-4 text-left transition-colors hover:bg-muted/50', style.borderL)}
      >
        <span className={cn('w-6 shrink-0 text-right text-sm font-bold', style.count)}>{bucket.items.length}</span>
        <span className="shrink-0 text-xs text-foreground">{t(BUCKET_LABEL_KEY[bucket.key])}</span>
        <span className="h-[7px] flex-1 overflow-hidden rounded bg-muted/50" role="presentation">
          <span className={cn('block h-full rounded', style.bar)} style={{ width: `${barPct}%` }} />
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
      </button>
      {/* AC7 — 펼침 시 전량(절단 0), 긴 구간은 스크롤(화면을 안 밀어냄). */}
      {expanded ? (
        <div className="max-h-[280px] overflow-y-auto">
          {bucket.items.map((item) => (
            <SilentStallExpandedRow key={item.id} item={item} memberNames={memberNames} t={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// story #93b076c8(2250) — "침묵의 정체" 신규 섹션(6번째 신호, ClusterShell tone="warning"
// 재사용). 유나 발주서: 헤드라인이 「막힌 것 없음」을 대체·4구간 exclusive+무게 escalation·
// 전량 무절단(구간별 펼침)·빨강 미사용. count(items.length)와 population(모집단 총량)은
// 서로 다른 수 — 지어내지 않고 BE 그대로(derive-silent-stall-clusters.ts 참조).
function SilentStallShell({
  clusters, memberNames,
}: {
  clusters: { totalCount: number; populationCount: number; buckets: SilentStallBucket[] };
  memberNames: Record<string, string>;
}) {
  const t = useTranslations('orgBriefing');
  const [expandedKey, setExpandedKey] = useState<SilentStallBucketKey | null>(null);
  if (clusters.totalCount === 0) return null;

  const maxCount = Math.max(...clusters.buckets.map((b) => b.items.length));
  // 유나 발주서 "최장 배지" — 가장 오래 방치된(=마지막) 비어있지 않은 구간.
  const longestNonEmpty = [...clusters.buckets].reverse().find((b) => b.items.length > 0);

  return (
    <ClusterShell
      tone="warning"
      icon={<EyeOff className="size-4" aria-hidden="true" />}
      title={t('clusterSilentStallTitle')}
      subtitle={t('clusterSilentStallSub', { population: clusters.populationCount })}
      count={clusters.totalCount}
      extraBadge={longestNonEmpty ? (
        <span className="shrink-0 rounded px-2 py-0.5 text-xs font-bold text-warning-strong bg-warning-tint border border-warning-border">
          {t(BUCKET_LABEL_KEY[longestNonEmpty.key])} {longestNonEmpty.items.length}
        </span>
      ) : null}
    >
      {clusters.buckets.map((bucket) => (
        <SilentStallBucketRow
          key={bucket.key}
          bucket={bucket}
          maxCount={maxCount}
          expanded={expandedKey === bucket.key}
          onToggle={() => setExpandedKey((k) => (k === bucket.key ? null : bucket.key))}
          memberNames={memberNames}
          t={t}
        />
      ))}
    </ClusterShell>
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

// story #2843/#2844 — 명시 "측정 불가" 선언 goal 수. measure_plan_missing과 동형(N 비포함·
// 집계만·개별 목록 없음) — 위조 채널 감시용(§4, unmeasurable 남발로 루프 N을 인위적으로
// 줄이는 걸 브리핑에서 볼 수 있게).
function UnmeasurableGoalNote({ count }: { count: number }) {
  const t = useTranslations('orgBriefing');
  if (count <= 0) return null;
  return (
    <p className="border-t border-border bg-muted/30 px-4 py-2 text-[11px] text-foreground">
      {t('clusterUnclosedUnmeasurableGoal', { count })}
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
  silentStall,
  loop,
  loopTotalCount,
  measurePlanMissingGoalCount,
  unmeasurableGoalCount,
  authFailure = [],
  memberNames = {},
}: {
  falsified: FalsifiedClusterItem[];
  // story #93b076c8(2250) — 기존 StalledClusterItem(org-wide·Story.updated_at 기반·부정확
  // 확定)을 완전히 대체(같은 PR — 페드루 판정 "교체+제거", 두 "정체" 섹션 공존 금지).
  silentStall: { totalCount: number; populationCount: number; buckets: SilentStallBucket[] };
  loop: LoopClusterItem[];
  loopTotalCount: number;
  measurePlanMissingGoalCount: number;
  unmeasurableGoalCount: number;
  authFailure?: AuthFailureClusterItem[];
  memberNames?: Record<string, string>;
}) {
  const t = useTranslations('orgBriefing');
  const [falsifiedExpanded, setFalsifiedExpanded] = useState(false);
  const [loopExpanded, setLoopExpanded] = useState(false);
  const [authFailureExpanded, setAuthFailureExpanded] = useState(false);

  const hasLoop = loopTotalCount > 0;
  const hasAuthFailure = authFailure.length > 0;
  const hasSilentStall = silentStall.totalCount > 0;
  if (falsified.length === 0 && !hasSilentStall && !hasLoop && !hasAuthFailure) return null;

  const shownFalsified = falsifiedExpanded ? falsified : falsified.slice(0, TOP_N);
  const shownLoop = loopExpanded ? loop : loop.slice(0, TOP_N);
  const shownAuthFailure = authFailureExpanded ? authFailure : authFailure.slice(0, TOP_N);
  const visibleCount = [falsified.length > 0, hasSilentStall, hasLoop, hasAuthFailure].filter(Boolean).length;

  return (
    <div
      className={cn(
        'mb-4 grid grid-cols-1 gap-3',
        visibleCount === 2 && 'lg:grid-cols-2',
        visibleCount >= 3 && 'lg:grid-cols-2 xl:grid-cols-3',
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
      {hasSilentStall ? <SilentStallShell clusters={silentStall} memberNames={memberNames} /> : null}
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
          <UnmeasurableGoalNote count={unmeasurableGoalCount} />
        </ClusterShell>
      ) : null}
      {hasAuthFailure ? (
        <ClusterShell
          tone="warning"
          icon={<KeyRound className="size-4" aria-hidden="true" />}
          title={t('clusterAuthFailureTitle')}
          subtitle={t('clusterAuthFailureSub')}
          count={authFailure.length}
        >
          {shownAuthFailure.map((item) => <AuthFailureRow key={item.id} item={item} memberNames={memberNames} />)}
          <ViewAllToggle
            expanded={authFailureExpanded}
            remaining={authFailure.length - TOP_N}
            onToggle={() => setAuthFailureExpanded((v) => !v)}
          />
        </ClusterShell>
      ) : null}
    </div>
  );
}
