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
 * 라이브 픽셀(2026-07-11)로 실측된 커밋-취소 레이스 fix — `/glance` 진입 직후 `useProjectSsot`의
 * URL `?p=` 정규화(router.replace)가 GlanceBoard를 재마운트시켜, 진행 중이던 fetch 체인이
 * "완주는 했지만 그 인스턴스의 cancelled 플래그가 이미 true"인 채로 끝나 영구 빈 화면이 됐다
 * (#2030의 "fan-out 100→8로 좁히면 레이스 소멸" 전제는 틀림 — fan-out 크기가 아니라 effect
 * cleanup이 로드 중 발동하는 구조 자체가 원인).
 *
 * 근본 fix: fetch 자체를 컴포넌트 인스턴스 밖(module-level in-flight map)으로 옮겨 dedupe한다.
 * 재마운트로 구 인스턴스가 취소돼도, 같은 projectId를 요청한 새 인스턴스가 **동일 in-flight
 * promise**를 그대로 이어받아 기다리므로 그 인스턴스의 커밋은 막히지 않는다(재마운트가 몇 차례
 * 일어나도 마지막으로 살아남은 인스턴스가 반드시 결과를 받는다). 완료 시 map에서 제거해 이후
 * 진짜 재로드(다른 projectId 등)는 새 fetch로 이어진다 — 무기한 캐시 아님.
 */
const inFlightByProject = new Map<string, Promise<GlanceData>>();

async function fetchGlanceData(projectId: string): Promise<GlanceData> {
  const [epicsJson, overviewJson, membersJson, activityJson] = await Promise.all([
    fetchJson(`/api/epics?project_id=${projectId}&limit=100`),
    fetchJson('/api/dashboard/overview'),
    fetchJson('/api/team-members'),
    fetchJson(`/api/activity-logs?project_id=${projectId}&limit=20`),
  ]);

  const arc = scopeRoadmapEpics(unwrap<BeEpicListItem[]>(epicsJson) ?? []);
  const overview = unwrap<{ project_status: { epics: EpicProgress[] } }>(overviewJson);
  const roadmap = mergeRoadmap(arc.epics, overview?.project_status.epics ?? []);

  const memberRows = unwrap<{ id: string; name: string }[]>(membersJson) ?? [];
  const memberNames: Record<string, string> = {};
  for (const m of memberRows) memberNames[m.id] = m.name;

  const storyLists = await Promise.all(roadmap.map((e) => fetchJson(`/api/stories?epic_id=${e.id}&limit=100`)));
  const stories = storyLists.flatMap((s) => unwrap<BeStoryListItem[]>(s) ?? []);
  const collaboration = deriveCollaboration(roadmap.map((e) => e.id), stories, memberNames);

  const activityItems = unwrap<BeActivityLogItem[]>(activityJson) ?? [];
  const events = filterMilestoneEvents(activityItems);

  return { roadmap, totalEpicCount: arc.totalCount, collaboration, events };
}

export function loadGlanceData(projectId: string): Promise<GlanceData> {
  const existing = inFlightByProject.get(projectId);
  if (existing) return existing;

  const promise = fetchGlanceData(projectId).finally(() => {
    inFlightByProject.delete(projectId);
  });
  inFlightByProject.set(projectId, promise);
  return promise;
}
