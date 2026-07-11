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
 * #2053 in-flight dedup(2026-07-11 1차)만으로는 부족했다 — 오르테가 라이브 재검증(puppeteer)이
 * dedup은 실제로 작동함(epic fetch 1회만)을 확인했는데도 여전히 빈 화면이었다. **핵심 통찰(오르테가
 * 진단)**: promise를 공유해도 그걸 `await`하는 지점은 여전히 컴포넌트 effect 안이라 그 인스턴스의
 * `cancelled`에 걸린다 — 재마운트가 반복되면(원인은 `useProjectSsot`의 router.replace뿐 아니라
 * 다른 remount 트리거도 있는 것으로 실측됨, 순수 reload에도 재현) 어느 인스턴스도 살아있는 채로
 * await을 끝내지 못해 영구 스킵될 수 있다. **await 경계가 취소 가능한 한 이 레이스는 안 죽는다.**
 *
 * 근본 fix(2차): 해소된 데이터를 module-level 캐시에 **컴포넌트 생존 여부와 무관하게 무조건** 쓴다
 * (`.then()`이 `cancelled`를 확인하지 않음 — fetch 자체가 컴포넌트 라이프사이클 밖에 있으므로).
 * `GlanceBoard`는 마운트 시 이 캐시를 **동기적으로**(useState 초기값) 읽어 렌더한다 — await을
 * 전혀 거치지 않으므로 취소될 여지 자체가 없다. 마지막까지 살아남은 인스턴스가 마운트되는 시점에
 * 이미 캐시가 있으면(직전 인스턴스가 fetch를 진행시켜 놨을 것이므로 거의 항상 있음) 그 즉시 렌더.
 * 없으면(최초 로드) 종전처럼 async fetch → 그 fetch가 뭘 하든 완료 즉시 캐시에 쓰이므로, 설령 그
 * 인스턴스가 취소돼도 캐시는 남고 **다음(몇 번째든) 마운트가 동기 읽기로 즉시 성공**한다.
 */
const inFlightByProject = new Map<string, Promise<GlanceData>>();
const resolvedCacheByProject = new Map<string, GlanceData>();

export function getCachedGlanceData(projectId: string): GlanceData | null {
  return resolvedCacheByProject.get(projectId) ?? null;
}

async function fetchGlanceData(projectId: string): Promise<GlanceData> {
  const [epicsJson, overviewJson, membersJson, activityJson] = await Promise.all([
    fetchJson(`/api/epics?project_id=${projectId}&limit=100`),
    fetchJson('/api/dashboard/overview'),
    fetchJson('/api/team-members'),
    fetchJson(`/api/activity-logs?project_id=${projectId}&limit=20`),
  ]);

  // 라이브 재현(2026-07-11, 오르테가 fiber 실측) — epics fetch가 초기 remount/타이밍 창에서
  // 실패(네트워크/401/헤더 미부착 등)하면 fetchJson이 null로 삼켜 "에픽 0개"와 구분이 안 된다.
  // 이걸 그대로 캐시하면 이후 모든 동기 읽기가 진짜 데이터 대신 이 유령 빈 결과를 영구히 반환한다
  // (resolvedCache 오염). epics는 로드맵의 필수 소스라 실패 시 reject해 caller가 재시도하게 한다
  // (loadGlanceData가 이 경우 캐시하지 않음 — 아래 참고).
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

  // 실 근본원인(2026-07-11, BE 소스+동작 레퍼런스로 확인) — GET /api/v2/activity-logs는 flat
  // 배열이 아니라 `ActivityLogListResponse{items,total,limit,offset}`(activity_logs.py:65)를
  // 반환한다. `.items` 추출 없이 이 wrapper를 배열인 척 filterMilestoneEvents에 넘기면
  // `items.filter is not a function`으로 **fetchGlanceData 자체가 매번 throw**했다 — 레이스나
  // 재마운트가 아니라 결정적 크래시였다(#2053~#2055가 전부 안 먹힌 진짜 이유). 같은 엔드포인트를
  // 쓰는 dashboard-activity-timeline.tsx가 `json.data.items`로 정확히 추출하는 걸 대조해 확인.
  const activityItems = unwrap<{ items: BeActivityLogItem[] }>(activityJson)?.items ?? [];
  const events = filterMilestoneEvents(activityItems);

  return { roadmap, totalEpicCount: arc.totalCount, collaboration, events };
}

export function loadGlanceData(projectId: string): Promise<GlanceData> {
  const existing = inFlightByProject.get(projectId);
  if (existing) return existing;

  const promise = fetchGlanceData(projectId)
    .then((data) => {
      // 컴포넌트 생존 여부와 무관하게 무조건 캐시(재마운트 레이스의 핵심 fix — 위 주석).
      resolvedCacheByProject.set(projectId, data);
      return data;
    })
    .finally(() => {
      inFlightByProject.delete(projectId);
    });
  inFlightByProject.set(projectId, promise);
  return promise;
}
