'use client';

import { useTranslations } from 'next-intl';
import type { FlowLaneRow } from './derive-flow';

interface FlowLaneProps {
  rows: FlowLaneRow[];
  totalEpicCount: number;
}

/**
 * story #2224(IA v2.2 §1-B) — "정보만 이전"(스파인·에픽 리스트 컴포넌트는 얹지 않는다. 줄기
 * 축이 그 정보를 담는다). RoadmapFlow/GlanceEpicList 컴포넌트 자체는 재사용하지 않고, 같은
 * 데이터(RoadmapEpic)를 이 화면 전용의 세로 레인으로 새로 그린다 — 컴포넌트를 얹으면 같은 것을
 * 두 번 말하게 된다(§I-6).
 */
export function FlowLane({ rows, totalEpicCount }: FlowLaneProps) {
  const t = useTranslations('flow');

  if (rows.length === 0) {
    return <p className="px-1 py-3 text-xs text-muted-foreground">{t('laneEmpty')}</p>;
  }

  return (
    <div className="w-full shrink-0 space-y-3 border-border lg:w-56 lg:border-r lg:pr-3">
      <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {t('laneHeading', { n: totalEpicCount })}
      </p>
      <ul className="space-y-2.5">
        {rows.map((row) => (
          <li key={row.id} className="space-y-1 px-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground">{row.title}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {row.done}/{row.total} · {row.completionPct}%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground/50" style={{ width: `${row.completionPct}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {/* 유나 규격(2026-07-30) — "미수집"·"미구현"처럼 갈라 보이지 않고 캔버스 쪽의 단일
          "아직 표시하지 않습니다" 고지에 항목만 합쳐 나열한다(flow-canvas.tsx 참조). 이 자리에
          별도 문구를 두지 않는다. */}
    </div>
  );
}
