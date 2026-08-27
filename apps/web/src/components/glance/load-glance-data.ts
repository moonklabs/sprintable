import type { EpicProgress } from '@/components/dashboard/command-center/types';
import {
  mergeRoadmap,
  scopeRoadmapEpics,
  type BeEpicListItem,
  type RoadmapEpic,
} from '@/services/glance';
import type { HeroStory, HeroMember } from './hero-logic';
import type { HeroEnvelope } from './derive-hero-envelope';
import { parseAttentionSignals, type BeAttentionSignal } from './derive-exception-signals';

// codex-silent-defect-sweep D-7 — overview/멤버/예외 fetch 실패를 `?? []`/`?? 0`으로 실제 빈
// 데이터처럼 치환하면 "데이터가 없다"와 "못 가져왔다"가 화면에서 구분이 안 된다. 폴백 자체(빈
// 배열로 렌더 지속)는 유지하되, 어떤 조각이 실패했는지 이 플래그로 caller에 넘겨 caller가 그
// 영역만 "재시도 가능" 표시로 구분되게 그린다 — 전면 에러 화면으로 바꾸지 않는다(부분 실패는
// 부분만 표시).
// story #2298(3단 웨이터폴 근절): `stories` 필드 삭제 — 예전엔 per-epic story-list fetch(웨이브②)의
// 실패를 따로 추적했으나, 그 fetch 자체가 없어졌다(heroStory 전부 epics(+glance) 응답에서
// 나온다 — 그 fetch가 실패하면 epicsRaw가 null이 되어 이 함수 자체가 throw한다, 아래 참고).
//
// story #2224(선생님 정정 2026-07-30) — `collaboration`·`events`·`activeEpicTitle` 필드와
// `/api/activity-logs` fetch를 삭제했다. 소비처가 `CollaborationMap`·`LiveStream`·
// `glance-board.tsx`(활동 카운터) 셋뿐이었는데, `/glance` 라우트 자체가 `/flow`로 흡수되며
// 이 셋 다 죽은 코드가 됐다(grep 전수 확認 — 사용처 0). "진행 궤적"은 선생님 판정대로 시간축이
// 대체하며 별도 이관하지 않는다. `/api/team-members` fetch는 «남는다» — `memberMap`(GlanceHero의
// human/agent 참여자 표시)이 여전히 그걸 쓰기 때문에, 죽는 건 그 응답에서 파생하던
// `collaboration` 배열 하나뿐이다. 이 함수의 caller는 이제 `flow-client.tsx`뿐이다(glance-board.tsx
// 삭제로).
export interface GlanceDataPartialErrors {
  overview: boolean;
  members: boolean;
  attention: boolean;
}

export interface GlanceData {
  roadmap: RoadmapEpic[];
  totalEpicCount: number;
  // E-GLANCE 2D 재설계(dee92c96): hero = 현재(active) 에픽의 focal 활성 story·없으면 null(hero 미표시).
  heroStory: HeroStory | null;
  memberMap: Record<string, HeroMember>;
  // 예외 스트림(story 0441a197): #2097 glance/attention 실신호(gate_pending·blocked·merge_ready).
  // 미가용/실패는 빈 배열로 정직 처리(throw 0) — 예외 스트림은 없으면 "손 필요한 것 없음" 빈상태.
  attentionSignals: BeAttentionSignal[];
  // hero ProofCapsule 리치 envelope(story 04da0281→#2298/#2303) — heroStory와 항상 짝(둘 다
  // null이거나 둘 다 존재). 예전엔 별도 fetch(웨이브③)라 story는 있는데 envelope만 실패하는
  // 상태가 가능했으나, 이제 같은 focal_story 객체에서 나오므로 그 상태 자체가 구조적으로 없다.
  heroEnvelope: HeroEnvelope | null;
  partialErrors: GlanceDataPartialErrors;
}

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

async function fetchJson(url: string): Promise<unknown> {
  return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

/**
 * E-GLANCE 현황판 데이터 병합 — 4개 fetch: `/api/goals?include=glance`(순서 SSOT + 참여·hero
 * 재료) · `/api/dashboard/overview`(진척) · `/api/team-members`(memberMap) ·
 * `/api/glance/attention`(예외 신호).
 * story #2298(3단 웨이터폴 근절, PO 실측 2026-07-28 — 로그인 後 2.07초가 이 웨이터폴에서
 * 나옴)+#2303(계약 확장): `roadmap.map(epic ⇒ /api/stories?epic_id=)`(N건, 예전 웨이브②)와
 * `/api/glance/hero?story_id=`(예전 웨이브③) 둘 다 제거 — `?include=glance`의
 * `participant_ids`/`focal_story`가 그 재료를 웨이브①에서 함께 싣는다. ⛔판정 기준은
 * "요청이 3→1로 줄었는가"가 아니라 "화면이 그리는 것 중 하나도 안 줄어드는가 + 요청이
 * 주는가"(PO 재확定, 2026-07-28) — hero envelope의 9필드(assignee_ids·proof_count·
 * auto_verify·gate.*·trust.*, glance-hero.tsx 호출체인 그라운딩으로 확정)가 전부 BE 계약에
 * 실려 화면 표시 내용은 한 글자도 안 줄었다.
 *
 * ⛔동작 변경 하나(PR 본문에도 명시): `pickFocalStory`의 gate-우선 분기가 이 story가 도입된
 * 2026-07-12부터 재료(story listing에 `gates` 필드 자체가 없었음) 없이 죽어있었다 — 지금
 * BE가 실제 gate 데이터로 그 분기를 처음 살린다. 지금까지는 in-progress 중 항상 첫 번째가
 * hero였는데, 이제부터는 gate-pending story가 있으면 그게 우선한다.
 *
 * story #2224(선생님 정정 2026-07-30) — `/api/activity-logs` fetch를 제거했다(5종→4종). 유일한
 * 소비처(`events`, LiveStream용)가 죽은 코드였다 — 그 fetch가 실측한 "로드맵 blank 재발"
 * 회귀가드(#c3d1565d, ActivityLogListResponse가 flat 배열이 아니라던 그 사건)는 이 함수와 함께
 * 사라지는 게 아니라, 그 방어적 unwrap 패턴 자체가 이제 이 파일에 없어도 된다는 뜻이다(다른
 * activity-logs 소비처는 각자의 파일에서 이미 독립적으로 같은 방어를 갖고 있다).
 */
export async function loadGlanceData(projectId: string): Promise<GlanceData> {
  const [epicsJson, overviewJson, membersJson, attentionJson] = await Promise.all([
    // wedge #2: order_by=position 옵트인 — 조타(큐레이션) 결과를 아크가 curated-first로 소비만
    // 반영(드래그 없음). position 모드는 커서 미발행이나 아크는 원래 전량로드(limit=100)라 무관.
    // story #2298/#2303: include=glance — participant_ids/focal_story를 같은 응답에 싣는다.
    fetchJson(`/api/goals?project_id=${projectId}&limit=100&order_by=position&include=glance`),
    fetchJson('/api/dashboard/overview'),
    fetchJson('/api/team-members'),
    // 예외 스트림 실신호(#2097) — project-scope 가드는 BE(404). 실패/미가용은 null→[](정직 빈상태).
    fetchJson(`/api/glance/attention?project_id=${projectId}`),
  ]);

  // epics는 로드맵의 필수 소스 — fetch 실패를 "에픽 0개"로 오인하면 정직하지 않은 빈 상태가
  // 된다(정책 실패 ≠ 실제 empty). 실패 시 throw해 caller(glance-board)가 조용히 빈 상태로 유지.
  const epicsRaw = unwrap<BeEpicListItem[]>(epicsJson);
  if (epicsRaw === null) throw new Error('glance: epics fetch failed');

  const arc = scopeRoadmapEpics(epicsRaw);
  const overview = unwrap<{ project_status: { epics: EpicProgress[] } }>(overviewJson);
  const roadmap = mergeRoadmap(arc.epics, overview?.project_status.epics ?? []);

  const memberRows = unwrap<{ id: string; name: string; type?: string }[]>(membersJson) ?? [];
  const memberMap: Record<string, HeroMember> = {};
  for (const m of memberRows) {
    memberMap[m.id] = { name: m.name, type: m.type ?? 'human' };
  }

  const rawById = new Map(arc.epics.map((e) => [e.id, e]));

  // 2D 재설계: hero = 현재(active) 에픽의 focal 활성 story. story #2298/#2303부터 story·
  // envelope 재료 전부 `focal_story`(같은 epics(+glance) 응답)에서 나온다 — 추가 fetch 0.
  //
  // 결함 fix(2026-07-30, 선생님 직접 발견 — "열린 스토리가 없다고 나오던데"): 이전엔 roadmap
  // 안에서 status==='active'인 «첫» 에픽을 무조건 집었다. 이 프로젝트엔 active 에픽이 52개나
  // 동시에 있어(179개 중) "첫 번째"가 실제 진행 상황과 무관하게 뽑혔다 — E-UI-DAEGBYEON(진행중
  // 스토리 실재)을 두고 E-CHAT-REALTIME(진행중 스토리 0건)이 "지금"으로 뽑혀 초점 스트립이
  // 항상 빈 채로 뜬 사례가 실측됨. focal_story가 실재하는 active 에픽을 우선한다 — 그런 에픽이
  // 하나도 없을 때만(=진짜 0건) 기존처럼 첫 active로 폴백(정직한 빈 상태).
  // story #2341 AC2 delta(2026-08-27) — "먼저 오는 하나"가 아니라 «가장 최근에 움직인 하나»로
  // 좁힌다. 이전 주석은 "BeEpicListItem엔 updated_at이 없다(BE 계약에 없음)"고 적어 뒀으나
  // 재그라운딩 결과 틀렸다 — `GoalResponse.updated_at`은 이미 존재했다(BE 신규 작업 0, FE
  // 노출만 누락돼 있었다). focal_story 유무로 먼저 가르고, 같은 그룹 안에서 updated_at 내림차순
  // tie-break. #2341 AC1의 근본 방향(㉡ "active"를 파생값化)은 아직 미결 — 이 tie-break는
  // 그 방향이 확정되기 전까지의 완화(PR#2680 계열)에 그친다.
  const byRecency = (a: RoadmapEpic, b: RoadmapEpic) =>
    (rawById.get(b.id)?.updated_at ?? '').localeCompare(rawById.get(a.id)?.updated_at ?? '');
  const activeWithFocal = roadmap.filter((e) => e.roadmapStatus === 'active' && rawById.get(e.id)?.focal_story);
  const activeAny = roadmap.filter((e) => e.roadmapStatus === 'active');
  const activeEpic =
    [...activeWithFocal].sort(byRecency)[0] ??
    [...activeAny].sort(byRecency)[0] ??
    null;
  const focal = activeEpic ? (rawById.get(activeEpic.id)?.focal_story ?? null) : null;
  const heroStory: HeroStory | null = focal
    ? { id: focal.id, title: focal.title, status: focal.status, assignee_id: focal.assignee_id, assignee_ids: focal.assignee_ids }
    : null;
  const heroEnvelope: HeroEnvelope | null = focal
    ? { proof_count: focal.proof_count, auto_verify: focal.auto_verify, gate: focal.gate, trust: focal.trust }
    : null;

  const partialErrors: GlanceDataPartialErrors = {
    overview: overviewJson === null,
    members: membersJson === null,
    attention: attentionJson === null,
  };

  // 예외 스트림: {data:{items}} envelope를 방어적으로 unwrap+검증(형상 불일치=생략, throw 0).
  const attentionSignals = parseAttentionSignals(attentionJson);

  return {
    roadmap,
    totalEpicCount: arc.totalCount,
    heroStory,
    memberMap,
    attentionSignals,
    heroEnvelope,
    partialErrors,
  };
}
