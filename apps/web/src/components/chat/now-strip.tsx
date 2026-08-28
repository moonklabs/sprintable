'use client';

/**
 * story #3177(S3a·SID 3177) — chat 구심점 상단 고정 「지금」 스트립. command-center attention
 * 7종을 임베드 카드로 흡수한다(AC 뼈 = doc 「S3 와이어 심화」§1·시안 렌더 doc
 * s3a-now-strip-mockup-render-20260828). 데이터원 = 기존 `/api/dashboard/my-actions`
 * 재사용(PO BE 계약 확定 2026-08-28, 신규 BE 0). collapsed/expanded 문법은 embed-group.tsx의
 * GateGroup(S2c③④)을 재사용(신규 패턴 0).
 *
 * ⚠️소멸 타이밍(AC4, PO 조정 2026-08-28): 진짜 실시간(SSE attention-changed)이 아니라
 * useAutoRefresh(전역 RefreshContext 폴링 주기, 기본 30초) 내 무회귀다 — 이벤트 기반 즉시
 * 소멸은 별 후속 스토리(entity:story:2b129e0b-b38d-4597-816a-914f43a5dfb3)로 분리됐다.
 *
 * ⚠️구조/데이터 층 우선(PO 지시 2026-08-28) — 시안(하이파이 mockup)의 좌측 그라데이션
 * 장식바·메타/시간 두 슬롯 분리 같은 미세 픽셀 디테일은 이 커밋에서 실 DS 프리미티브로
 * 근사만 하고, 최종 픽셀 대조는 QA 라이브 확認 라운드에서 조정한다(신규색 0은 이미 지킴).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, AlertTriangle, Clock, Ban, Target, FlaskConical } from 'lucide-react';
import { fetchWithAuth } from '@/lib/db/client';
import { cn } from '@/lib/utils';
import { cardVariants } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import type { AttentionItem, MyActions } from '@/components/dashboard/command-center/types';
import { buildNowStripItems, summarizeSeverity, type NowStripItem, type NowStripSeverity } from './derive-now-strip';

// 카드 좌측 심각도 바 + 점 요약(둘 다 solid 배경색, 텍스트 아님) — tint 배경 위 계열색
// «글자» 조합은 만들지 않는다(story #2420 회귀가드 — bg-tint+text-family 공존 금지).
// 아이콘 배지는 중립(bg-muted/text-muted-foreground)만 쓴다.
const SEVERITY_SOLID_BG: Record<NowStripSeverity, string> = {
  danger: 'bg-destructive',
  warn: 'bg-warning',
  info: 'bg-info',
};

const TYPE_ICON: Record<AttentionItem['type'], typeof AlertTriangle> = {
  agent_stuck: Clock,
  agent_auth_failure: AlertTriangle,
  unanswered_blocker: Ban,
  hypothesis_falsified: FlaskConical,
  loop_overdue_hypothesis: FlaskConical,
  loop_overdue_goal: Target,
  loop_outcome_missing_goal: Target,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unwrap<T>(json: unknown): T | null {
  if (!isRecord(json)) return null;
  const d = json['data'];
  return (d ?? json) as T;
}

function NowStripCard({ item }: { item: NowStripItem }) {
  const Icon = TYPE_ICON[item.type];
  return (
    <Link
      href={item.href}
      className={cn(
        cardVariants({ radius: 'card' }),
        'flex items-center gap-2.5 p-2.5 text-xs transition hover:border-muted-foreground/30',
      )}
    >
      <span className={cn('h-full w-[3px] shrink-0 self-stretch rounded-full', SEVERITY_SOLID_BG[item.severity])} aria-hidden="true" />
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{item.title}</span>
        <span className="block truncate text-muted-foreground">{item.detail}</span>
      </span>
    </Link>
  );
}

const SEVERITY_GROUP_LABEL_KEY: Record<NowStripSeverity, string> = {
  danger: 'nowStripGroupDanger',
  warn: 'nowStripGroupWarn',
  info: 'nowStripGroupInfo',
};

const SEVERITY_GROUP_TEXT: Record<NowStripSeverity, string> = {
  danger: 'text-destructive',
  warn: 'text-foreground',
  info: 'text-info',
};

function groupBySeverity(items: NowStripItem[]): { severity: NowStripSeverity; items: NowStripItem[] }[] {
  const order: NowStripSeverity[] = ['danger', 'warn', 'info'];
  return order
    .map((severity) => ({ severity, items: items.filter((i) => i.severity === severity) }))
    .filter((g) => g.items.length > 0);
}

export interface NowStripProps {
  /** agent_stuck 라벨용(action-zone.tsx와 동일 계약) — 없으면 attentionEntityLabel 자체의
   * entity_type 폴백(no-fiction)으로 떨어진다, 필수 아님. */
  resolveName?: (id: string | null | undefined) => string | null;
  /** story #3178(S3b) AC2 — 「지금」 스트립+pulse 카드 합산 불변식(최대 1 expand)을 위해
   * 부모(chat-list-view.tsx)가 펼침 상태를 끌어올려 통제할 수 있게 한다. 둘 다 생략하면
   * (S3a 단독 시절과 동일) 내부 state로 자율 동작 — 하이브리드 controlled/uncontrolled. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function NowStrip({ resolveName, expanded: expandedProp, onExpandedChange }: NowStripProps) {
  const t = useTranslations('chats');
  const tDashboard = useTranslations('dashboard');
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [expandedState, setExpandedState] = useState(false);
  const expanded = expandedProp ?? expandedState;
  const setExpanded = useCallback(
    (next: boolean) => { if (onExpandedChange) onExpandedChange(next); else setExpandedState(next); },
    [onExpandedChange],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/dashboard/my-actions');
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      const ma = unwrap<MyActions>(json);
      setItems(ma?.attention.items ?? null);
    } catch {
      // non-critical — 스트립이 비어도 chat 목록 본체엔 영향 없음.
    }
  }, []);

  // command-center.tsx의 동형 마운트-fetch 패턴(load가 setItems를 비동기로 호출) — 정적분석이
  // "effect 안 setState"로 잡는 기존 코드베이스 관례(connect-step.tsx 등)를 따라 disable.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useAutoRefresh('chat-now-strip', () => { void load(); });

  const noopResolveName = useCallback((): string | null => null, []);
  const stripItems = useMemo(
    () => buildNowStripItems(items ?? [], tDashboard, resolveName ?? noopResolveName, {}),
    [items, tDashboard, resolveName, noopResolveName],
  );

  if (stripItems.length === 0) return null;

  const summary = summarizeSeverity(stripItems);
  const groups = groupBySeverity(stripItems);

  return (
    <div className={cn(cardVariants({ radius: 'card' }), 'sticky top-0 z-10 mb-2')}>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded(!expanded)}
        className="h-auto w-full items-center justify-start gap-2.5 rounded-b-none px-3 py-2.5 text-left font-normal hover:bg-muted/40"
        aria-expanded={expanded}
      >
        <span className="text-[12.5px] font-semibold text-foreground">{t('nowStripLabel')}</span>
        <span className="font-mono text-[12.5px] font-semibold text-foreground">{t('nowStripCount', { count: summary.total })}</span>
        <span className="ml-0.5 flex items-center gap-2">
          {summary.danger > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className={cn('size-2 rounded-full', SEVERITY_SOLID_BG.danger)} aria-hidden="true" />{summary.danger}
            </span>
          )}
          {summary.warn > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className={cn('size-2 rounded-full', SEVERITY_SOLID_BG.warn)} aria-hidden="true" />{summary.warn}
            </span>
          )}
          {summary.info > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className={cn('size-2 rounded-full', SEVERITY_SOLID_BG.info)} aria-hidden="true" />{summary.info}
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronUp className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="sr-only">{expanded ? t('nowStripCollapse') : t('nowStripExpand')}</span>
      </Button>
      {expanded && (
        <div className="space-y-2 border-t border-border p-2 pt-1.5">
          {groups.map((g) => (
            <div key={g.severity} className="space-y-1">
              <p className={cn('px-1 pt-1 text-[10.5px] font-semibold tracking-wide uppercase', SEVERITY_GROUP_TEXT[g.severity])}>
                {t(SEVERITY_GROUP_LABEL_KEY[g.severity])}
              </p>
              {g.items.map((item) => <NowStripCard key={item.key} item={item} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
