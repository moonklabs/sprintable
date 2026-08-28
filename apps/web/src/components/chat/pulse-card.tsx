'use client';

/**
 * story #3178(S3b·SID 3178) — chat 구심점 「지금」 스트립 아래 고정 「프로젝트 맥박」 카드.
 * AC 뼈 = doc 「S3 와이어 심화」§2c/2d·시안 렌더 doc s3b-pulse-card-mockup-render-20260828.
 * command-center OverviewZone(project pulse)을 이 표면으로 이사한다 — 항목 단위 다이어트
 * 근거는 derive-pulse-card.ts 헤더에 실 표면 대조 기록(PO 구현 시점 조건 이행).
 *
 * 데이터원 = 기존 `/api/dashboard/overview`(Overview) 재사용, 신규 BE 0.
 *
 * ⚠️AC2 합산 불변식(스트립+pulse 동시 펼침이 첫 화면을 안 먹음) — expanded/onExpandedChange를
 * 부모(chat-list-view.tsx)가 통제해 「최대 1 expand」를 강제한다(now-strip.tsx와 동형
 * controlled/uncontrolled 하이브리드).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Gauge } from 'lucide-react';
import { fetchWithAuth } from '@/lib/db/client';
import { cn } from '@/lib/utils';
import { cardVariants } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import type { Overview } from '@/components/dashboard/command-center/types';
import { buildPulseCardData, isPulseCardEmpty, type PulseCardData } from './derive-pulse-card';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unwrap<T>(json: unknown): T | null {
  if (!isRecord(json)) return null;
  const d = json['data'];
  return (d ?? json) as T;
}

// mockup의 ▁▂▃▅▃ proof 스파크라인을 실 데이터로 근사(8단 블록, 최댓값 기준 정규화) —
// 새 색·새 라이브러리 없이 텍스트만으로. 포인트가 1개 이하면 변화를 그릴 수 없어 생략.
const SPARK_BLOCKS = '▁▂▃▄▅▆▇█';
export function sparkline(points: number[]): string {
  if (points.length < 2) return '';
  const max = Math.max(...points, 0);
  if (max <= 0) return SPARK_BLOCKS[0]!.repeat(points.length);
  return points.map((p) => {
    const idx = Math.min(SPARK_BLOCKS.length - 1, Math.floor((Math.max(0, p) / max) * (SPARK_BLOCKS.length - 1)));
    return SPARK_BLOCKS[idx];
  }).join('');
}

export interface PulseCardProps {
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function PulseCard({ expanded: expandedProp, onExpandedChange }: PulseCardProps) {
  const t = useTranslations('chats');
  const tDashboard = useTranslations('dashboard');
  const tGlance = useTranslations('glance');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [expandedState, setExpandedState] = useState(false);
  const expanded = expandedProp ?? expandedState;
  const setExpanded = useCallback(
    (next: boolean) => { if (onExpandedChange) onExpandedChange(next); else setExpandedState(next); },
    [onExpandedChange],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/dashboard/overview');
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      setOverview(unwrap<Overview>(json));
    } catch {
      // non-critical — pulse 카드가 비어도 chat 목록 본체엔 영향 없음(now-strip.tsx와 동형).
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useAutoRefresh('chat-pulse-card', () => { void load(); });

  const data: PulseCardData = buildPulseCardData(overview);
  if (isPulseCardEmpty(data)) return null;

  const epicSummary = data.activeEpic
    ? `${data.activeEpic.title} · ${tGlance(`phrase.${data.activeEpic.phrase}`)}`
    : t('pulseEpicEmpty');

  return (
    <div className={cn(cardVariants({ radius: 'card' }), 'sticky top-0 z-10 mb-2')}>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded(!expanded)}
        className="h-auto w-full items-center justify-start gap-2.5 rounded-b-none px-3 py-2.5 text-left font-normal hover:bg-muted/40"
        aria-expanded={expanded}
      >
        <span className="flex size-5.5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Gauge className="size-3" aria-hidden="true" />
        </span>
        <span className="text-[12.5px] font-semibold text-foreground">{t('pulseLabel')}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{epicSummary}</span>
        {expanded ? (
          <ChevronUp className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
      </Button>
      {expanded && (
        <div className="space-y-2.5 border-t border-border p-2.5 pt-2">
          {data.activeEpic && (
            <div className="rounded-lg bg-muted/40 p-2.5">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate text-foreground">{data.activeEpic.title}</span>
                <span className="shrink-0 font-mono text-muted-foreground">{data.activeEpic.completionPct}%</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground/60" style={{ width: `${data.activeEpic.completionPct}%` }} />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {data.failedRuns !== null && (
              <div className="rounded-lg bg-muted/40 p-2.5">
                <p className="text-[10.5px] text-muted-foreground">{tDashboard('ccRiskFailedRuns')}</p>
                <p className="font-mono text-sm font-semibold text-foreground">{data.failedRuns}</p>
              </div>
            )}
            {data.cycleTime !== null && (
              <div className="rounded-lg bg-muted/40 p-2.5">
                <p className="text-[10.5px] text-muted-foreground">{tDashboard('ccCycleTitle')}</p>
                <p className="text-sm font-semibold text-foreground">
                  {data.cycleTime.sample > 0 ? tDashboard('ccCycleValue', { days: data.cycleTime.avgDays ?? 0, n: data.cycleTime.sample }) : tDashboard('ccCycleEmpty')}
                </p>
              </div>
            )}
            {data.contribution !== null && (
              <div className="rounded-lg bg-muted/40 p-2.5">
                <p className="text-[10.5px] text-muted-foreground">{tDashboard('ccContributionTitle')}</p>
                <p className="text-[11px] font-semibold text-foreground">
                  {tDashboard('ccContributionValue', { agent: data.contribution.agent, human: data.contribution.human, unassigned: data.contribution.unassigned })}
                </p>
              </div>
            )}
            {data.costTrend !== null && (
              <div className="rounded-lg bg-muted/40 p-2.5">
                <p className="text-[10.5px] text-muted-foreground">{t('pulseCostTrendLabel')}</p>
                <p className="font-mono text-sm font-semibold text-foreground">
                  {sparkline(data.costTrend.points)} <span className="text-[11px] text-muted-foreground">${data.costTrend.totalUsd.toFixed(0)}</span>
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
