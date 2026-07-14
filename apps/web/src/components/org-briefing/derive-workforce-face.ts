/**
 * 조직 브리핑 "워크포스" 면(story 09fa254e) — doc org-briefing-hypothesis-grammar-blueprint §1.5.
 *
 * ⚠️감시 최고위험 지점(§1.6 리트머스). collaboration-map.tsx(E-GLANCE §5)와 동일 하드라인 계승:
 * **참여 = "붙어있나" 여부만** — 개인별 처리량·순위·기여도 %·시간 절대 집계/노출 안 함.
 *
 * 데이터 = `/api/dashboard/overview`(active 에픽, S1/S2에서 이미 재사용한 BFF) + active 에픽별
 * `/api/stories?epic_id=`(story assignee_ids/agent_delegate_ids/self_reported/human_verified —
 * BE는 이미 모든 list 응답에 이 필드들을 붙이지만 FE 기존 `Story` 타입엔 선언이 없어[core-storage
 * IStoryRepository.ts] 원시 payload를 직접 파싱한다, S1/S2와 동형 그라운딩 갭) + `/api/team-members`
 * (이름 resolve). 신규 BE 0.
 *
 * trust는 **positive 단방향**(§1.7): 에픽 내 스토리 중 하나라도 human_verified면 'verified'(역행
 * 없음), 아니면 하나라도 self_reported/has_evidence면 'claimed', 둘 다 없으면 트러스트 뱃지 자체를
 * 생략(지어내지 않음 — no-fiction). verified 뱃지에 인간 이름/시각을 동반하지 않는다(⛔시간 낙인 0 —
 * trust-seal.tsx의 verified variant는 `when` 텍스트를 노출해 이 면의 규율과 충돌하므로 재사용하지
 * 않고, Badge 기반의 이름·시각 없는 압축 씰만 렌더한다).
 */

export type TrustLevel = 'verified' | 'claimed' | null;

export interface WorkforceEpic {
  epicId: string;
  title: string;
}

export interface RawWorkforceStory {
  assigneeIds: string[];
  selfReported: boolean;
  humanVerified: boolean;
}

export interface WorkforceFaceItem {
  id: string;
  title: string;
  collaboratorIds: string[];
  trust: TrustLevel;
  trustLabel: string | null;
}

export interface WorkforceFaceTranslator {
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

/** `/api/dashboard/overview` → status==='active' 에픽만(§1.5 "데이터=active 에픽"). */
export function parseActiveEpics(json: unknown): WorkforceEpic[] {
  const inner = unwrapEnvelope(json);
  const epics = isRecord(inner) && isRecord(inner['project_status'])
    ? (inner['project_status'] as Record<string, unknown>)['epics'] : null;
  const out: WorkforceEpic[] = [];
  if (!Array.isArray(epics)) return out;
  for (const raw of epics) {
    if (!isRecord(raw)) continue;
    if (raw['status'] !== 'active') continue;
    const epicId = str(raw['epic_id']);
    const title = str(raw['title']);
    if (!epicId || !title) continue;
    out.push({ epicId, title });
  }
  return out;
}

/** `/api/stories?epic_id=` → 신뢰/참여 파생에 필요한 최소 필드만. story_id 등은 불요(집계만 함). */
export function parseEpicStories(json: unknown): RawWorkforceStory[] {
  const inner = unwrapEnvelope(json);
  const rows = Array.isArray(inner) ? inner : [];
  const out: RawWorkforceStory[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const assigneeIdsRaw = Array.isArray(raw['assignee_ids']) ? (raw['assignee_ids'] as unknown[]) : [];
    const agentIdsRaw = Array.isArray(raw['agent_delegate_ids']) ? (raw['agent_delegate_ids'] as unknown[]) : [];
    const legacyAssignee = str(raw['assignee_id']);
    const ids = new Set<string>();
    for (const v of [...assigneeIdsRaw, ...agentIdsRaw]) if (typeof v === 'string' && v) ids.add(v);
    if (legacyAssignee) ids.add(legacyAssignee);
    out.push({
      assigneeIds: [...ids],
      selfReported: raw['self_reported'] === true || raw['has_evidence'] === true,
      humanVerified: raw['human_verified'] === true,
    });
  }
  return out;
}

export interface RawTeamMember {
  id: string;
  name: string;
}

/** `/api/team-members` → id→name 맵(이니셜/툴팁 resolve용, collaboration-map.tsx와 동형). */
export function parseTeamMembers(json: unknown): Record<string, string> {
  const inner = unwrapEnvelope(json);
  const rows = Array.isArray(inner) ? inner : [];
  const out: Record<string, string> = {};
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const id = str(raw['id']);
    const name = str(raw['name']);
    if (id && name) out[id] = name;
  }
  return out;
}

/**
 * active 에픽 + 스토리별 참여/신뢰 신호 → WorkforceFace 렌더 항목. 참여자는 distinct id만(개수·
 * 처리량 집계 안 함). trust는 positive 단방향(verified > claimed > 없음, 역행 없음).
 */
export function buildWorkforceFace(
  epics: WorkforceEpic[],
  storiesByEpic: Record<string, RawWorkforceStory[]>,
  t: WorkforceFaceTranslator,
): WorkforceFaceItem[] {
  return epics.map((epic) => {
    const stories = storiesByEpic[epic.epicId] ?? [];
    const collaboratorIds = [...new Set(stories.flatMap((s) => s.assigneeIds))];
    const trust: TrustLevel = stories.some((s) => s.humanVerified)
      ? 'verified'
      : stories.some((s) => s.selfReported)
        ? 'claimed'
        : null;
    return {
      id: epic.epicId,
      title: epic.title,
      collaboratorIds,
      trust,
      trustLabel: trust === 'verified' ? t('workforceTrustVerified') : trust === 'claimed' ? t('workforceTrustClaimed') : null,
    };
  });
}
