// story #2224 후속(2026-07-31, PO 지시 — 아티팩트 a920c25f v2 "갈래 — 다음을 만드는 화면")
// 실측이 초점을 바꿨다: done이 압도 다수(전체의 79% 언저리)이고 ready-for-dev는 소수라 —
// 문제는 "다음이 안 보이는 것"이 아니라 "다음이 없는 것"이다. 이 모듈은 그 계산의 순수 핵심.
//
// "다음이 정해졌다"의 정의(PO 정렬 규격에서 역산, 명시 필드가 스키마에 없다) — 이 목표에
// status='ready-for-dev' 스토리가 «하나라도» 있으면 다음이 정해진 것이다. in-progress만
// 있고 ready-for-dev가 없는 목표는 «다음이 없는» 쪽(1순위, "진행 중인데 다음이 없는" 정의와
// 정확히 일치 — 진행 중인 것이 끝나면 뒤이을 것이 없다는 뜻).

export interface NextMakerGoal {
  id: string;
  title: string;
  status: string; // draft | active | done | archived (GOAL_STATUSES)
  totalStories: number;
  doneStories: number;
}

export interface RawGoal {
  id: string;
  title: string;
  status: string;
  total_stories: number;
  done_stories: number;
}

export function parseGoals(raw: RawGoal[]): NextMakerGoal[] {
  return raw.map((g) => ({
    id: g.id, title: g.title, status: g.status, totalStories: g.total_stories, doneStories: g.done_stories,
  }));
}

/**
 * 라이브 실측 결함 fix(2026-07-31, PO 지적 — 배포 직후 발견) — 이 필터가 빠져 있어 이미
 * `done`/`archived`인 목표까지 「다음이 없다」로 세고 있었다(226개 중 223개, 그중
 * 195개가 이미 닫힌 목표). 이미 끝난 목표에 다음이 없는 것은 당연한 사실이지, 사람이
 * 처리할 숙제가 아니다 — 「다음을 만드는 화면」의 대상은 «활성» 목표뿐이다. `draft`도
 * 제외한다(사람 확認 前 초안 — draft→active 전이 자체가 human-only, PO 판정 GOAL_STATUSES
 * 참고). 이 필터는 goals 배열 하나에만 적용하면 되는 «단일 근본원인»이다 — 그 뒤를 잇는
 * deriveGoalStems/deriveHeadline은 무변경으로 올바른 수를 낸다(활성 목표만 들어오므로
 * "217개는 이미 끝났을 수 있습니다"도 자연히 "활성인데 오래 조용한 것"이 된다).
 */
export function filterActiveGoals(goals: NextMakerGoal[]): NextMakerGoal[] {
  return goals.filter((g) => g.status === 'active');
}

export interface NextMakerStory {
  id: string;
  storyNumber: number;
  title: string;
  status: string;
  assigneeId: string | null;
  updatedAt: string;
  epicId: string | null;
}

export interface RawStoryLite {
  id: string;
  story_number: number;
  title: string;
  status: string;
  assignee_id: string | null;
  updated_at: string;
  epic_id: string | null;
}

export function parseStories(raw: RawStoryLite[]): NextMakerStory[] {
  return raw.map((s) => ({
    id: s.id,
    storyNumber: s.story_number,
    title: s.title,
    status: s.status,
    assigneeId: s.assignee_id,
    updatedAt: s.updated_at,
    epicId: s.epic_id,
  }));
}

export interface NextUpRow {
  id: string;
  sourceId: string;
  sourceStoryNumber: number;
  sourceTitle: string;
  sourceClosedAt: string;
  targetId: string;
  targetStoryNumber: number;
  targetTitle: string;
  relationKind: string | null;
  status: string;
  isRecent: boolean;
}

export interface RawNextUp {
  id: string;
  source_id: string;
  source_story_number: number;
  source_title: string;
  source_closed_at: string;
  target_id: string;
  target_story_number: number;
  target_title: string;
  relation_kind: string | null;
  status: string;
  is_recent: boolean;
}

export function parseNextUp(raw: RawNextUp[]): NextUpRow[] {
  return raw.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    sourceStoryNumber: r.source_story_number,
    sourceTitle: r.source_title,
    sourceClosedAt: r.source_closed_at,
    targetId: r.target_id,
    targetStoryNumber: r.target_story_number,
    targetTitle: r.target_title,
    relationKind: r.relation_kind,
    status: r.status,
    isRecent: r.is_recent,
  }));
}

// "지금"(진행) 정의 — epic-flow-nodes/epics-progress-lane과 동일(in-progress + in-review).
// 다른 정의를 새로 만들면 같은 화면 생태계 안에서 "지금"이 두 벌 선다(오늘 반복 관측된 병).
const NOW_STATUSES = new Set(['in-progress', 'in-review']);

export type StemPriority = 'about-to-stall' | 'recently-active' | 'quiet';

export interface GoalStem {
  epicId: string;
  title: string;
  totalStories: number;
  doneStories: number;
  inProgressCount: number;
  waitingCount: number; // backlog
  readyForDevCount: number;
  hasNext: boolean;
  recentlyClosed: boolean;
  /** null = 다음이 이미 정해진 목표(45건 밖) — 정렬/헤드라인 집계 대상이 아니다. */
  priority: StemPriority | null;
}

/**
 * goals × (project 전체 non-done stories) → 목표별 줄기. `recentlyClosedEpicIds`는
 * `deriveRecentlyClosedEpicIds`로 별도 계산해 주입한다(순수 함수 조합 — 이 함수 안에서
 * next-up 원시 데이터를 다시 안 훑는다).
 */
export function deriveGoalStems(
  goals: NextMakerGoal[],
  activeStories: NextMakerStory[],
  recentlyClosedEpicIds: Set<string>,
): GoalStem[] {
  const byEpic = new Map<string, NextMakerStory[]>();
  for (const s of activeStories) {
    if (!s.epicId) continue;
    const list = byEpic.get(s.epicId);
    if (list) list.push(s);
    else byEpic.set(s.epicId, [s]);
  }

  return goals.map((g) => {
    const stories = byEpic.get(g.id) ?? [];
    let inProgressCount = 0;
    let waitingCount = 0;
    let readyForDevCount = 0;
    for (const s of stories) {
      if (NOW_STATUSES.has(s.status)) inProgressCount += 1;
      else if (s.status === 'backlog') waitingCount += 1;
      else if (s.status === 'ready-for-dev') readyForDevCount += 1;
    }
    const hasNext = readyForDevCount > 0;
    const recentlyClosed = recentlyClosedEpicIds.has(g.id);

    let priority: StemPriority | null = null;
    if (!hasNext) {
      // PO 정렬 규격(2026-07-31, 그대로) — 1순위: 진행 중인데 다음이 없음(곧 멈춤).
      // 2순위: 최근 닫힘(줄기가 살아있음). 3순위: 조용함(둘 다 아님) → "아직 하는 중입니까?".
      // ⛔"움직임 순"이 아니다 — 잘 도는 것을 또 보여주는 것을 PO가 명시로 금지했다.
      if (inProgressCount > 0) priority = 'about-to-stall';
      else if (recentlyClosed) priority = 'recently-active';
      else priority = 'quiet';
    }

    return {
      epicId: g.id,
      title: g.title,
      totalStories: g.totalStories,
      doneStories: g.doneStories,
      inProgressCount,
      waitingCount,
      readyForDevCount,
      hasNext,
      recentlyClosed,
      priority,
    };
  });
}

/** next-up 응답(project 전체)에서 target_id가 이 project의 살아있는 스토리 중 하나와
 * 맞아떨어지면(=target이 아직 backlog인 실제 스토리) 그 스토리의 epic_id를 "최근 닫힘"
 * 목표로 표시한다. next-up 자체엔 epic_id가 없어(BE 계약, 그라운딩 확認) 이 조인이 필요하다. */
export function deriveRecentlyClosedEpicIds(nextUp: NextUpRow[], activeStories: NextMakerStory[]): Set<string> {
  const epicByStoryId = new Map(activeStories.map((s) => [s.id, s.epicId] as const));
  const result = new Set<string>();
  for (const row of nextUp) {
    if (!row.isRecent) continue;
    const epicId = epicByStoryId.get(row.targetId);
    if (epicId) result.add(epicId);
  }
  return result;
}

const STEM_PRIORITY_ORDER: Record<StemPriority, number> = {
  'about-to-stall': 0,
  'recently-active': 1,
  quiet: 2,
};

/** 「다음이 비어 있는 목표」 목록 정렬 — 멈출 임박 순(PO 판정, "움직임 순 아닌"). 안정
 * 정렬(Array.prototype.sort는 ES2019+ 표준으로 stable)이라 동순위 내부는 입력 순서 유지. */
export function sortStemsByStallUrgency(stems: GoalStem[]): GoalStem[] {
  return [...stems].sort((a, b) => {
    const pa = a.priority ? STEM_PRIORITY_ORDER[a.priority] : 99;
    const pb = b.priority ? STEM_PRIORITY_ORDER[b.priority] : 99;
    return pa - pb;
  });
}

export interface NextMakerHeadline {
  totalGoals: number;
  /** 첫 줄의 "45" — 다음(ready-for-dev)이 하나도 없는 목표 수. */
  needsNextCount: number;
  /** 첫 줄의 "3" — 그중 진행 중인데 다음이 없어 «곧 멈추는» 것. */
  aboutToStallCount: number;
  /** "N개는 이미 끝났을 수 있습니다" — 조용한(3순위) 목표 수. */
  quietCount: number;
  /** "다음이 정해진 목표 — N개" 섹션 카운트. */
  hasNextCount: number;
}

export function deriveHeadline(stems: GoalStem[]): NextMakerHeadline {
  let needsNextCount = 0;
  let aboutToStallCount = 0;
  let quietCount = 0;
  for (const s of stems) {
    if (s.hasNext) continue;
    needsNextCount += 1;
    if (s.priority === 'about-to-stall') aboutToStallCount += 1;
    else if (s.priority === 'quiet') quietCount += 1;
  }
  return {
    totalGoals: stems.length,
    needsNextCount,
    aboutToStallCount,
    quietCount,
    hasNextCount: stems.length - needsNextCount,
  };
}

export interface ZeroStageStats {
  /** "지금 바로 할 수 있는" — ready-for-dev + 주인 있음. */
  canDo: number;
  /** "준비됐는데 주인이 없는" — ready-for-dev + 주인 없음. */
  unowned: number;
  /** "문이 닫혀 막힌" — Gate 기반 정의(epics-progress-lane의 lane.blocked와 동일 필터,
   * 형제 화면과 다른 수를 말하지 않기 위해 여기서 새로 정의하지 않고 그 합을 그대로 받는다). */
  blocked: number;
  /** "아직 준비 안 된" 전체(backlog). */
  backlogTotal: number;
  /** backlog 중 주인 있는 수. */
  backlogOwned: number;
}

export function deriveZeroStageStats(activeStories: NextMakerStory[], blockedCount: number): ZeroStageStats {
  let canDo = 0;
  let unowned = 0;
  let backlogTotal = 0;
  let backlogOwned = 0;
  for (const s of activeStories) {
    if (s.status === 'ready-for-dev') {
      if (s.assigneeId) canDo += 1;
      else unowned += 1;
    } else if (s.status === 'backlog') {
      backlogTotal += 1;
      if (s.assigneeId) backlogOwned += 1;
    }
  }
  return { canDo, unowned, blocked: blockedCount, backlogTotal, backlogOwned };
}
