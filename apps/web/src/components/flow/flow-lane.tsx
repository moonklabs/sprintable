'use client';

import { useTranslations } from 'next-intl';
import type { FlowLaneRow } from './derive-flow';

interface FlowLaneProps {
  rows: FlowLaneRow[];
  totalEpicCount: number;
}

interface Flag {
  key: 'blocked' | 'stalled' | 'inProgress' | 'waiting';
  count: number;
  tone: 'warn' | 'info' | 'neutral';
}

/** 행 하나의 플래그 목록. 유나 목업(eacf5b50, "갈래 — 축척 4층")의 L2 대륙 규격 —
 * 0인 항목은 생략(범위가 아니라 "지금 이 목표에 실제로 걸려 있는 것"만 말한다). */
function buildFlags(row: FlowLaneRow): Flag[] {
  const flags: Flag[] = [];
  if (row.blocked > 0) flags.push({ key: 'blocked', count: row.blocked, tone: 'warn' });
  if (row.stalled > 0) flags.push({ key: 'stalled', count: row.stalled, tone: 'warn' });
  if (row.inProgress > 0) flags.push({ key: 'inProgress', count: row.inProgress, tone: 'info' });
  if (row.waiting > 0) flags.push({ key: 'waiting', count: row.waiting, tone: 'neutral' });
  return flags;
}

const FLAG_TONE_CLASS: Record<Flag['tone'], string> = {
  warn: 'border-destructive/50 text-destructive font-semibold',
  info: 'border-info/50 text-info',
  neutral: 'border-border text-muted-foreground',
};

/**
 * story #2224(IA v2.2 §1-B) — "정보만 이전"(스파인·에픽 리스트 컴포넌트는 얹지 않는다. 줄기
 * 축이 그 정보를 담는다). RoadmapFlow/GlanceEpicList 컴포넌트 자체는 재사용하지 않고, 같은
 * 데이터(RoadmapEpic)를 이 화면 전용의 세로 레인으로 새로 그린다 — 컴포넌트를 얹으면 같은 것을
 * 두 번 말하게 된다(§I-6).
 *
 * L2 정정(유나 목업 eacf5b50, 2026-07-30, 선생님 지적) — 퍼센트 진행률 막대는 "무엇을 해야
 * 하는지" 말하지 않는다("64/129"와 "3건 멈춤"은 다른 말). #2672가 이미 착지시킨 5분류
 * (막힘·대기·진행·멈춤·그외)를 오늘에서야 배선해, 퍼센트 막대 대신 상태 플래그바로 바꾼다.
 */
export function FlowLane({ rows, totalEpicCount }: FlowLaneProps) {
  const t = useTranslations('flow');

  if (rows.length === 0) {
    return <p className="px-1 py-3 text-xs text-muted-foreground">{t('laneEmpty')}</p>;
  }

  // ⛔결함 fix(2026-07-30, 선생님 실측 지적 — "/flow 모바일 최적화가 하나도 안 됐다") — 옛
  // `w-full`은 이 컴포넌트가 캔버스 없이 단독 스택으로 쓰이던 시절의 흔적이다. 지금은 항상
  // `flex` 행의 형제(FlowCanvas와 나란히)라 `w-full`이 행 전체(390px 뷰포트에서도)를 먹어
  // 캔버스를 0폭으로 밀어냈다(실측: FlowCanvas 렌더 폭 0px). 본격 모바일 재설계는 #2225 —
  // 이번 판은 "안 깨지게"만: lg 미만에서도 좁은 고정폭으로 캔버스에 자리를 준다.
  return (
    <div className="w-32 shrink-0 space-y-3 border-border lg:w-64 lg:border-r lg:pr-3">
      <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {t('laneHeading', { n: totalEpicCount })}
      </p>
      <ul className="space-y-2">
        {rows.map((row) => {
          const flags = buildFlags(row);
          return (
            <li
              key={row.id}
              className={`space-y-1 rounded-md border border-l-[3px] px-2 py-1.5 ${
                row.hasLaneData && (row.blocked > 0 || row.stalled > 0)
                  ? 'border-border border-l-destructive'
                  : row.hasLaneData && row.inProgress > 0
                    ? 'border-border border-l-info'
                    : 'border-border border-l-border'
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-foreground">{row.title}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {row.done}/{row.total}
                </span>
              </div>
              {!row.hasLaneData ? (
                <p className="text-[10px] text-muted-foreground">{t('laneUnknown')}</p>
              ) : flags.length === 0 ? (
                // PO 지적(2026-07-30) — 플래그 넷이 다 0인 것은 "완료"(done===total)와 "아직
                // 아무도 안 잡음"(done<total, 백로그뿐)의 서로 다른 두 사실을 가릴 수 있다.
                // "이상 없음" 한 문구로 덮으면 오늘 하루 반복 잡은 그 병(다른 것을 같은 말로
                // 덮는 것)의 재발이라 — zones에 이미 있는 done/total로 갈라 각자 정직하게 말한다.
                <span className="inline-block rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
                  {row.done === row.total ? t('laneComplete') : t('laneNotStarted')}
                </span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {flags.map((flag) => (
                    <span
                      key={flag.key}
                      className={`rounded border px-1 py-0.5 font-mono text-[10px] ${FLAG_TONE_CLASS[flag.tone]}`}
                    >
                      {t(`laneFlag_${flag.key}`, { n: flag.count })}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* 유나 목업(eacf5b50) L2 footer 고지 — 퍼센트를 안 쓰는 이유를 이 자리에서 한 번만
          말한다(행마다 반복하지 않음). */}
      <p className="px-1 text-[10px] text-muted-foreground">{t('laneWarnMsg')}</p>
    </div>
  );
}
