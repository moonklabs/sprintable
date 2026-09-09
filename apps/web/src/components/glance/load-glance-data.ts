import { fetchWithAuth } from '@/lib/db/client';
import type { HeroMember } from './hero-logic';
import { parseAttentionSignals, type BeAttentionSignal } from './derive-exception-signals';

// story #3710(2026-09-09, 페드루 PO 決) — 이 함수는 예전엔 `/api/goals`(로드맵 에픽)+
// `/api/dashboard/overview`(진척)까지 4개 fetch로 `roadmap`/`totalEpicCount`/`heroStory`/
// `heroEnvelope`를 함께 실었다. grep 전수 확認(story #3705 그라운딩, 페드루) — 그 필드들의
// 유일 소비처였던 flow-client.tsx는 실제로 `attentionSignals`·`memberMap`만 읽는다(:208·
// :279) — roadmap/hero 계열은 소비 0인 죽은 경로였다. "갈래" 뷰는 이제 `NextMakerScreen`이
// `/api/goals`를 자기 cursor-모드 fetch(hasMore 이어달리기)로 독립 로드해 그리므로(#3705가
// 겨냥한 100건 잘림 버그가 이 화면엔 애초에 없었다), 죽은 경로를 정직화하는 대신 통째로
// 걷어낸다 — "은퇴했는데 코드는 살아 있다"를 남기지 않는다.
//
// 남는 두 엔드포인트(team-members·glance/attention)는 실 소비처가 있다:
// memberMap(NextMakerScreen의 GoalStemCard 담당자 이름)·attentionSignals(ExceptionStream).
export interface GlanceDataPartialErrors {
  members: boolean;
  attention: boolean;
}

export interface GlanceData {
  memberMap: Record<string, HeroMember>;
  // 예외 스트림(story 0441a197): #2097 glance/attention 실신호(gate_pending·blocked·merge_ready).
  // 미가용/실패는 빈 배열로 정직 처리(throw 0) — 예외 스트림은 없으면 "손 필요한 것 없음" 빈상태.
  attentionSignals: BeAttentionSignal[];
  partialErrors: GlanceDataPartialErrors;
}

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

async function fetchJson(url: string): Promise<unknown> {
  // story #4062 후속(2026-09-09, 페드루 PO 決) — raw fetch 가드(#2691)가 fetch 4→2 축소로
  // grandfather 호출 모양 키가 사라져 나머지 둘을 "신규"로 잡았다. fetchWithAuth(정본 401
  // 재시도 경로)로 전환 — 이 파일이 조용히 재인증 없이 401을 삼키지 않게 한다.
  return fetchWithAuth(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

/**
 * E-GLANCE 현황판 데이터 — 2개 fetch: `/api/team-members`(memberMap) · `/api/glance/attention`
 * (예외 신호). 둘 다 실패에 관대하다(throw 0) — 이 파일엔 더 이상 "필수" 소스가 없다(예전엔
 * 에픽 fetch가 필수였으나 story #3710에서 그 경로 자체를 제거했다).
 */
export async function loadGlanceData(projectId: string): Promise<GlanceData> {
  const [membersJson, attentionJson] = await Promise.all([
    fetchJson('/api/team-members'),
    // 예외 스트림 실신호(#2097) — project-scope 가드는 BE(404). 실패/미가용은 null→[](정직 빈상태).
    fetchJson(`/api/glance/attention?project_id=${projectId}`),
  ]);

  const memberRows = unwrap<{ id: string; name: string; type?: string }[]>(membersJson) ?? [];
  const memberMap: Record<string, HeroMember> = {};
  for (const m of memberRows) {
    memberMap[m.id] = { name: m.name, type: m.type ?? 'human' };
  }

  const partialErrors: GlanceDataPartialErrors = {
    members: membersJson === null,
    attention: attentionJson === null,
  };

  // 예외 스트림: {data:{items}} envelope를 방어적으로 unwrap+검증(형상 불일치=생략, throw 0).
  const attentionSignals = parseAttentionSignals(attentionJson);

  return { memberMap, attentionSignals, partialErrors };
}
