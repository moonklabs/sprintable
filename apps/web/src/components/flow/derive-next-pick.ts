// story #2224 후속(2026-07-31) — 「다음 고르기」 패널(줄기 하나를 펼쳤을 때) 순수 계산.
// PO 지시(아티팩트 a920c25f v2 ④) — "거르지 않고 근거만 붙인다": 자격을 정해 거르면 사람의
// 판단을 대신하는 것이라 후보를 줄이지 않는다. 위로 올리되(정렬) 전부 보인다(개수 제한 없음).
import type { NextMakerStory } from './derive-next-maker';

export type NextPickReasonKey = 'recently-spawned' | 'referenced' | 'owned' | 'long-waiting';

export const LONG_WAIT_DAYS = 14; // next-up의 recent_days=14와 대칭 — "최근"의 반대말로 같은 창을 쓴다.

export interface NextPickCandidate {
  story: NextMakerStory;
  reasons: NextPickReasonKey[];
  waitingDays: number;
  /** 근거가 하나라도 있으면 참 — 렌더 레이어가 "cand top" 스타일(강조 테두리)에 쓴다. */
  hasEvidence: boolean;
}

/**
 * 이 목표의 backlog 스토리 전부 → 근거 붙인 후보 목록(정렬됨, 잘라내지 않음).
 * `nextUpTargetIds`/`referenceCandidateTargetIds`는 호출부가 이 목표 범위로 이미 좁혀 넘긴다
 * (이 함수는 "어느 것이 이 목표 소속인가"를 다시 판정하지 않는다 — 그 조인은 fetch 레이어의 몫).
 * `nowMs`는 주입(순수 함수가 시계를 스스로 읽지 않는다 — 결정적 테스트를 위해).
 */
export function deriveNextPickCandidates(
  backlogStories: NextMakerStory[],
  nextUpTargetIds: Set<string>,
  referenceCandidateTargetIds: Set<string>,
  nowMs: number,
): NextPickCandidate[] {
  const candidates = backlogStories.map((story) => {
    const reasons: NextPickReasonKey[] = [];
    if (nextUpTargetIds.has(story.id)) reasons.push('recently-spawned');
    if (referenceCandidateTargetIds.has(story.id)) reasons.push('referenced');
    if (story.assigneeId) reasons.push('owned');
    const waitingMs = nowMs - new Date(story.updatedAt).getTime();
    const waitingDays = Math.max(0, Math.floor(waitingMs / 86_400_000));
    if (waitingDays >= LONG_WAIT_DAYS) reasons.push('long-waiting');
    return { story, reasons, waitingDays, hasEvidence: reasons.length > 0 };
  });

  // 근거 많은 순 → 동률이면 오래 기다린 순(안정 정렬, 나머지는 입력 순서 그대로).
  return candidates.sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    return b.waitingDays - a.waitingDays;
  });
}

/** "top" 후보 개수 — 유나 목업(a920c25f)이 3을 보였다. 나머지는 "나머지 N건"으로 접힌다. */
export const NEXT_PICK_TOP_COUNT = 3;
