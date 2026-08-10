/**
 * story #2541(#2539 스코프 ④ FE 이관, 유나 v4 SSOT f01fa94a) — 홈 브리핑 "신호 유형별 클러스터
 * 보드". 기존 NowFace가 story_stalled를 개별 flat 행으로 20건까지 그대로 나열해 「동일 문구
 * 반복 · 가치 0」 지적(선생님)을 받았다 — 그 원인 자체(derive-now-face.ts buildNowFace)를
 * 건드리지 않고, 같은 `raw.attention`(parseMyActions 산출)을 이 파일이 별도로 읽어 두 유형
 * (가설 반증 · 스토리 정체)만 클러스터로 묶는다. buildNowFace는 이 두 타입을 더는 flat 행으로
 * 안 올린다(중복 표시 방지).
 */
import type { RawAttentionItem } from './derive-now-face';

export interface FalsifiedClusterItem {
  id: string;
  title: string;
  target: number | null;
  actual: number | null;
  hasOutcome: boolean;
  supersededId: string | null;
  href: string;
}

export interface StalledClusterItem {
  id: string;
  title: string;
  days: number | null;
  href: string;
}

export interface AttentionClusters {
  falsified: FalsifiedClusterItem[];
  stalled: StalledClusterItem[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface ClusterTranslator {
  (key: string, values?: Record<string, string | number>): string;
}

/**
 * raw.attention → 두 클러스터. 정렬(AC3): 반증=최근순(falsified_days 오름차순 — 작을수록
 * 최근), 정체=일수순(stalled_days 내림차순 — 오래 묵은 것 먼저, 유나 v4 mockup 예시와 동일).
 * story_id/hypothesis_id가 없는 항목도 no-fiction 원칙상 세지 않을 이유는 없다(BE count와
 * 화면 count가 어긋나면 그게 더 정직하지 않다) — href만 제네릭 폴백으로 둔다(기존
 * buildNowFace의 story_stalled/unanswered_blocker 관례 재사용).
 */
export function deriveAttentionClusters(attention: RawAttentionItem[], t: ClusterTranslator): AttentionClusters {
  const falsified: { item: FalsifiedClusterItem; days: number | null }[] = [];
  const stalled: StalledClusterItem[] = [];

  attention.forEach((a, idx) => {
    if (a.type === 'hypothesis_falsified') {
      const outcome = isRecord(a.outcome_result) ? a.outcome_result : null;
      const actual = outcome ? num(outcome['actual']) : null;
      const target = outcome ? num(outcome['target']) : null;
      falsified.push({
        item: {
          id: a.hypothesis_id ?? `hypothesis_falsified-${idx}`,
          title: a.statement ?? t('signalHypothesisFalsifiedTitle'),
          target,
          actual,
          hasOutcome: actual !== null && target !== null,
          supersededId: a.superseded_by_hypothesis_id,
          href: a.hypothesis_id ? `/flow?hypothesis=${a.hypothesis_id}` : '/flow',
        },
        days: a.falsified_days,
      });
    } else if (a.type === 'story_stalled') {
      stalled.push({
        id: a.story_id ?? `story_stalled-${idx}`,
        title: a.title ?? t('signalStalledTitle'),
        days: a.stalled_days,
        href: a.story_id ? `/board?story=${a.story_id}` : '/board',
      });
    }
  });

  // 최근순 = falsified_days 오름차순(작을수록 최근 반증). 값이 없으면(BE 미배선) 뒤로 민다.
  falsified.sort((x, y) => (x.days ?? Infinity) - (y.days ?? Infinity));
  // 일수순 = stalled_days 내림차순(오래 묵은 것 먼저, 유나 v4 mockup 예시와 동일).
  stalled.sort((x, y) => (y.days ?? -Infinity) - (x.days ?? -Infinity));

  return { falsified: falsified.map((f) => f.item), stalled };
}
