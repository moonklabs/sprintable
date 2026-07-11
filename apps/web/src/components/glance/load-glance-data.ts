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

export interface GlanceData {
  roadmap: RoadmapEpic[];
  totalEpicCount: number;
  collaboration: EpicCollaboration[];
  events: BeActivityLogItem[];
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
 * E-GLANCE 현황판 데이터 병합 — §10 소스 4종: /api/epics(순서 SSOT) · /api/dashboard/overview
 * (진척) · /api/stories?epic_id=(참여) · /api/activity-logs(생동). 로드맵 blank 재발(2026-07-11)
 * 진짜 근본은 이 함수의 activity-logs 처리였다 — `GET /api/v2/activity-logs`는 flat 배열이
 * 아니라 `ActivityLogListResponse{items,total,limit,offset}`(activity_logs.py:65)를 반환하는데
 * `.items` 추출 없이 그 wrapper를 배열인 척 넘겨 매번 throw했다(dashboard-activity-timeline.tsx의
 * `json.data.items`와 대조해 확인). 애초에 재마운트 레이스가 아니라 이 결정적 크래시였던 것으로
 * 밝혀져, 이전 라운드(in-flight dedup·resolvedCache·동기 마운트 읽기)의 module-level 캐시
 * 복잡도는 걷어냈다(#c3d1565d, less-is-more) — 단순 1회 fetch로 되돌린다.
 */
export async function loadGlanceData(projectId: string): Promise<GlanceData> {
  const [epicsJson, overviewJson, membersJson, activityJson] = await Promise.all([
    fetchJson(`/api/epics?project_id=${projectId}&limit=100`),
    fetchJson('/api/dashboard/overview'),
    fetchJson('/api/team-members'),
    fetchJson(`/api/activity-logs?project_id=${projectId}&limit=20`),
  ]);

  // epics는 로드맵의 필수 소스 — fetch 실패를 "에픽 0개"로 오인하면 정직하지 않은 빈 상태가
  // 된다(정책 실패 ≠ 실제 empty). 실패 시 throw해 caller(glance-board)가 조용히 빈 상태로 유지.
  const epicsRaw = unwrap<BeEpicListItem[]>(epicsJson);
  if (epicsRaw === null) throw new Error('glance: epics fetch failed');

  const arc = scopeRoadmapEpics(epicsRaw);
  const overview = unwrap<{ project_status: { epics: EpicProgress[] } }>(overviewJson);
  const roadmap = mergeRoadmap(arc.epics, overview?.project_status.epics ?? []);

  const memberRows = unwrap<{ id: string; name: string }[]>(membersJson) ?? [];
  const memberNames: Record<string, string> = {};
  for (const m of memberRows) memberNames[m.id] = m.name;

  const storyLists = await Promise.all(roadmap.map((e) => fetchJson(`/api/stories?epic_id=${e.id}&limit=100`)));
  const stories = storyLists.flatMap((s) => unwrap<BeStoryListItem[]>(s) ?? []);
  const collaboration = deriveCollaboration(roadmap.map((e) => e.id), stories, memberNames);

  // activity-logs는 flat 배열이 아니라 {items,...} wrapper — 위 함수 doc 참고.
  const activityItems = unwrap<{ items: BeActivityLogItem[] }>(activityJson)?.items ?? [];
  const events = filterMilestoneEvents(activityItems);

  return { roadmap, totalEpicCount: arc.totalCount, collaboration, events };
}
