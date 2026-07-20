import type { EpicProgress } from '@/components/dashboard/command-center/types';
import {
  deriveCollaboration,
  mergeRoadmap,
  filterMilestoneEvents,
  scopeRoadmapEpics,
  type BeActivityLogItem,
  type BeEpicListItem,
  type BeStoryListItem,
  type EpicCollaboration,
  type RoadmapEpic,
} from '@/services/glance';
import { pickFocalStory, type HeroStory, type HeroMember } from './hero-logic';
import { parseAttentionSignals, type BeAttentionSignal } from './derive-exception-signals';
import { parseHeroEnvelope, type HeroEnvelope } from './derive-hero-envelope';

export interface GlanceData {
  roadmap: RoadmapEpic[];
  totalEpicCount: number;
  collaboration: EpicCollaboration[];
  events: BeActivityLogItem[];
  // E-GLANCE 2D 재설계(dee92c96): hero = 현재(active) 에픽의 focal 활성 story·없으면 null(hero 미표시).
  activeEpicTitle: string | null;
  heroStory: HeroStory | null;
  memberMap: Record<string, HeroMember>;
  // 예외 스트림(story 0441a197): #2097 glance/attention 실신호(gate_pending·blocked·merge_ready).
  // 미가용/실패는 빈 배열로 정직 처리(throw 0) — 예외 스트림은 없으면 "손 필요한 것 없음" 빈상태.
  attentionSignals: BeAttentionSignal[];
  // hero ProofCapsule 리치 envelope(story 04da0281): #2099 glance/hero. 형상 붕괴/미가용은 null →
  // hero 최소 렌더 폴백(claim+state+참여자만·no-fiction). heroStory 없으면 애초에 fetch 안 함.
  heroEnvelope: HeroEnvelope | null;
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
 * E-GLANCE 현황판 데이터 병합 — §10 소스 4종: /api/goals(순서 SSOT) · /api/dashboard/overview
 * (진척) · /api/stories?epic_id=(참여) · /api/activity-logs(생동). 로드맵 blank 재발(2026-07-11)
 * 진짜 근본은 이 함수의 activity-logs 처리였다 — `GET /api/v2/activity-logs`는 flat 배열이
 * 아니라 `ActivityLogListResponse{items,total,limit,offset}`(activity_logs.py:65)를 반환하는데
 * `.items` 추출 없이 그 wrapper를 배열인 척 넘겨 매번 throw했다(dashboard-activity-timeline.tsx의
 * `json.data.items`와 대조해 확인). 애초에 재마운트 레이스가 아니라 이 결정적 크래시였던 것으로
 * 밝혀져, 이전 라운드(in-flight dedup·resolvedCache·동기 마운트 읽기)의 module-level 캐시
 * 복잡도는 걷어냈다(#c3d1565d, less-is-more) — 단순 1회 fetch로 되돌린다.
 */
export async function loadGlanceData(projectId: string): Promise<GlanceData> {
  const [epicsJson, overviewJson, membersJson, activityJson, attentionJson] = await Promise.all([
    // wedge #2: order_by=position 옵트인 — 조타(큐레이션) 결과를 아크가 curated-first로 소비만
    // 반영(드래그 없음). position 모드는 커서 미발행이나 아크는 원래 전량로드(limit=100)라 무관.
    fetchJson(`/api/goals?project_id=${projectId}&limit=100&order_by=position`),
    fetchJson('/api/dashboard/overview'),
    fetchJson('/api/team-members'),
    fetchJson(`/api/activity-logs?project_id=${projectId}&limit=20`),
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
  const memberNames: Record<string, string> = {};
  const memberMap: Record<string, HeroMember> = {};
  for (const m of memberRows) {
    memberNames[m.id] = m.name;
    memberMap[m.id] = { name: m.name, type: m.type ?? 'human' };
  }

  const storyLists = await Promise.all(roadmap.map((e) => fetchJson(`/api/stories?epic_id=${e.id}&limit=100`)));
  const stories = storyLists.flatMap((s) => unwrap<BeStoryListItem[]>(s) ?? []);
  const collaboration = deriveCollaboration(roadmap.map((e) => e.id), stories, memberNames);

  // 2D 재설계: hero = 현재(active) 에픽의 focal 활성 story. 위에서 이미 per-epic으로 받은
  // 스토리 목록(storyLists)을 재사용해 활성 에픽의 full 스토리에서 focal을 고른다(추가 fetch 0).
  const activeEpic = roadmap.find((e) => e.roadmapStatus === 'active') ?? null;
  let heroStory: HeroStory | null = null;
  if (activeEpic) {
    const idx = roadmap.findIndex((e) => e.id === activeEpic.id);
    const activeStories = unwrap<HeroStory[]>(storyLists[idx]) ?? [];
    heroStory = pickFocalStory(activeStories);
  }

  // hero 리치 envelope — focal story가 있을 때만 fetch(#2099 glance/hero). 실패/형상붕괴는 null →
  // hero 최소 렌더 폴백(parseHeroEnvelope가 방어). 신규 fetch는 hero 있는 경우 1회뿐(추가부하 최소).
  let heroEnvelope: HeroEnvelope | null = null;
  if (heroStory) {
    const heroJson = await fetchJson(`/api/glance/hero?story_id=${heroStory.id}`);
    heroEnvelope = parseHeroEnvelope(heroJson);
  }

  // activity-logs는 flat 배열이 아니라 {items,...} wrapper — 위 함수 doc 참고.
  const activityItems = unwrap<{ items: BeActivityLogItem[] }>(activityJson)?.items ?? [];
  const events = filterMilestoneEvents(activityItems);

  // 예외 스트림: {data:{items}} envelope를 방어적으로 unwrap+검증(형상 불일치=생략, throw 0).
  const attentionSignals = parseAttentionSignals(attentionJson);

  return {
    roadmap,
    totalEpicCount: arc.totalCount,
    collaboration,
    events,
    activeEpicTitle: activeEpic?.title ?? null,
    heroStory,
    memberMap,
    attentionSignals,
    heroEnvelope,
  };
}
