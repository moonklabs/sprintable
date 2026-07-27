/**
 * 조직 브리핑 "루프" 면(story 6b707960) — doc org-briefing-hypothesis-grammar-blueprint §1.4.
 *
 * ⚠️ 1급 `Hypothesis` 엔티티(status 7종: proposed/active/measuring/verified/falsified/killed/archived
 * — `packages/core-storage/src/interfaces/IHypothesisRepository.ts`)를 쓴다. 구 `Sprint.success_hypothesis`
 * /`Epic.success_hypothesis`(자유텍스트 레거시 필드)와 **다른 개념** — 절대 혼동 금지(§6 명시).
 *
 * 데이터 = `/api/hypotheses?project_id=`(프로젝트 전체 가설) + `/api/dashboard/overview`(에픽 진척,
 * S1에서 이미 재사용한 BFF — completion_pct/total을 E-GLANCE `derivePhrase`에 그대로 먹임). 신규 BE 0.
 *
 * soul-lock(§1.4·hypothesis-status-badge.tsx §12.1 동일 규율): falsified(반증)는 **빨강 금지** — 학습
 * 데이터이지 실패가 아니다. testing/learning 전부 info, achieved만 success(저강도).
 *
 * forward-only(§1.4): 과거 아카이브·완료 목록 소환 0 — killed/archived 가설은 렌더 대상에서 제외.
 * "다음 루프"는 아직 활성화 전인 proposed 가설 중 1건만(가장 먼저 생성된 것)·트라젝토리 없음·dim.
 */

export type LoopKind = 'testing' | 'achieved' | 'learning' | 'next';

export interface LoopFaceItem {
  id: string;
  kind: LoopKind;
  kindLabel: string;
  statement: string;
  trajectoryLabel: string | null;
  trajectoryPct: number | null;
  dimmed: boolean;
  priority: number;
}

export interface LoopFaceTranslator {
  (key: string, values?: Record<string, string | number>): string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unwrapEnvelope(json: unknown): unknown {
  if (!isRecord(json)) return json;
  const d = json['data'];
  return d ?? json;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const KNOWN_STATUSES = new Set(['proposed', 'active', 'measuring', 'verified', 'falsified', 'killed', 'archived']);

export interface RawHypothesis {
  id: string;
  status: string;
  statement: string;
  epicId: string | null;
  createdAt: string | null;
}

/** 실 payload → 검증된 가설 목록. status/statement/id 없는 항목은 렌더할 수 없어 생략(no-fiction). */
export function parseHypotheses(json: unknown): RawHypothesis[] {
  const inner = unwrapEnvelope(json);
  const rows = Array.isArray(inner) ? inner : [];
  const out: RawHypothesis[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const id = str(raw['id']);
    const status = str(raw['status']);
    const statement = str(raw['statement']);
    if (!id || !status || !KNOWN_STATUSES.has(status) || !statement) continue;
    const epicIds = Array.isArray(raw['epic_ids']) ? (raw['epic_ids'] as unknown[]) : [];
    const epicId = typeof epicIds[0] === 'string' ? (epicIds[0] as string) : null;
    out.push({ id, status, statement, epicId, createdAt: str(raw['created_at']) });
  }
  return out;
}

export interface EpicProgress {
  title: string;
  completionPct: number;
  total: number;
}

/** `/api/dashboard/overview` → epic_id 키의 진척 맵. 핵심 필드 없는 항목은 생략(no-fiction). */
export function parseEpicProgress(json: unknown): Record<string, EpicProgress> {
  const inner = unwrapEnvelope(json);
  const epics = isRecord(inner) && isRecord(inner['project_status'])
    ? (inner['project_status'] as Record<string, unknown>)['epics'] : null;
  const out: Record<string, EpicProgress> = {};
  if (!Array.isArray(epics)) return out;
  for (const raw of epics) {
    if (!isRecord(raw)) continue;
    const epicId = str(raw['epic_id']);
    const title = str(raw['title']);
    if (!epicId || !title) continue;
    const completionPct = typeof raw['completion_pct'] === 'number' ? raw['completion_pct'] : 0;
    const total = typeof raw['total'] === 'number' ? raw['total'] : 0;
    out[epicId] = { title, completionPct, total };
  }
  return out;
}

export type ProgressPhrase = 'notStarted' | 'justStarted' | 'underway' | 'almostThere' | 'wrappingUp';

/** E-GLANCE §4 계승 — %숫자 강박 아닌 정성 언어 우선, 숫자는 보조(services/glance.ts derivePhrase 동형). */
export function derivePhrase(completionPct: number, total: number): ProgressPhrase {
  if (total === 0 || completionPct <= 0) return 'notStarted';
  if (completionPct < 25) return 'justStarted';
  if (completionPct < 60) return 'underway';
  if (completionPct < 90) return 'almostThere';
  return 'wrappingUp';
}

const KIND_BY_STATUS: Record<string, LoopKind | null> = {
  active: 'testing', measuring: 'testing',
  verified: 'achieved',
  falsified: 'learning',
  proposed: 'next',
  killed: null, archived: null, // forward-only — 아카이브/종료는 소환하지 않음.
};

const KIND_PRIORITY: Record<LoopKind, number> = { testing: 0, achieved: 1, learning: 1, next: 2 };

/**
 * 원시 가설 + 에픽 진척 → LoopFace 렌더 항목. testing/achieved/learning은 전부(uncapped — 동시
 * 검증 중 가설은 통상 소수), proposed(다음 루프)는 가장 먼저 생성된 1건만(§1.4 forward-only:
 * "지금 도는 루프 + 다음 루프", 대기열 전체 나열 아님).
 */
export function buildLoopFace(
  hypotheses: RawHypothesis[],
  epicProgress: Record<string, EpicProgress>,
  t: LoopFaceTranslator,
): LoopFaceItem[] {
  const items: LoopFaceItem[] = [];
  let nextCandidate: RawHypothesis | null = null;

  for (const h of hypotheses) {
    const kind = KIND_BY_STATUS[h.status];
    if (!kind) continue; // killed/archived — forward-only 제외.
    if (kind === 'next') {
      if (!nextCandidate || (h.createdAt && nextCandidate.createdAt && h.createdAt < nextCandidate.createdAt)) {
        nextCandidate = h;
      }
      continue;
    }
    const epic = h.epicId ? epicProgress[h.epicId] : undefined;
    const trajectoryPct = epic ? Math.min(100, Math.max(0, epic.completionPct)) : null;
    const trajectoryLabel = epic
      ? t('loopTrajectoryNote', { epic: epic.title, phrase: t(`loopPhrase${capitalize(derivePhrase(epic.completionPct, epic.total))}`) })
      : null;
    items.push({
      id: h.id, kind, kindLabel: t(kindLabelKey(kind)),
      statement: h.statement, trajectoryLabel, trajectoryPct,
      dimmed: false, priority: KIND_PRIORITY[kind],
    });
  }

  if (nextCandidate) {
    items.push({
      id: nextCandidate.id, kind: 'next', kindLabel: t('loopKindNext'),
      statement: nextCandidate.statement, trajectoryLabel: null, trajectoryPct: null,
      dimmed: true, priority: KIND_PRIORITY.next,
    });
  }

  return items.sort((a, b) => a.priority - b.priority);
}

function kindLabelKey(kind: LoopKind): string {
  switch (kind) {
    case 'testing': return 'loopKindTesting';
    case 'achieved': return 'loopKindAchieved';
    case 'learning': return 'loopKindLearning';
    case 'next': return 'loopKindNext';
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
