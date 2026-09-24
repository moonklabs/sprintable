/**
 * story #3831(UX-v3·FE 3·오늘) — 「오늘」 화면 본문. BE 계약 SSOT = story #3823
 * `GET /api/v2/today`(backend/app/services/today_service.py 직접 실측, 자체 집계 0).
 *
 * conversation_id는 story #3828(PR#4253, develop 착지)로 today_service.py가 채우기
 * 시작했다 — 캐폴러가 실참여자인 실행만 노출(비참여 conversation_id는 null). 파싱은
 * 응답 값을 그대로 옮길 뿐(지어내지 않음), 소비부(오늘 화면)는 "있으면 링크·없으면 0"
 * 분기라 무변경으로 실데이터를 받는다.
 */

export type NeedsMeState = 'approval' | 'signature' | 'answer';
export type NeedsMeRisk = 'low' | 'high';

export interface TodayNeedsMeItem {
  id: string;
  source: 'gate' | 'hitl' | 'workflow_step';
  state: NeedsMeState;
  // story #3962 CHANGES-2(페드루 PO C2, 2026-09-16 16:08Z) — 시안 ① 위험 등급 태그가
  // state(승인/서명/답)와 별개 축(BE `risk: Literal["low","high"]`, today.py:39 실측)
  // 이라 원값을 그대로 보존한다 — deriveNeedsMeState가 이미 이 값을 판정에 쓰지만
  // 그 결과(state)만 남기고 버렸던 걸 v3가 필요로 해서 복원.
  risk: NeedsMeRisk;
  workItemType: string;
  workItemId: string;
  workItemTitle: string;
  requestedByName: string | null;
  reason: string | null;
  createdAt: string;
  conversationId: string | null;
  // story #4190(유나 «본 버전 대조» 2) — BE `recipe_publish`(레시피 발행 게이트 — 초안을 보고 승인해야 함). true면 저위험
  // 일괄 승인에서 빼고 개별 카드(«초안 보고 승인» → 게이트 상세)로 둔다.
  recipePublish: boolean;
  // story #4241 — 이 항목의 프로젝트(BE needs_me `project_id` · gate = work_item 프로젝트 · hitl = 요청 행 · workflow_step은 null).
  // 「오늘」은 조직 전체 목록이라 게이트 상세 링크는 «현재 프로젝트»가 아니라 이 값을 `?p=`로 싣는다.
  projectId: string | null;
}

// story #3970(BE PR #4364, story #3961) — 정지 요청 상태. state는 BE 순수파생값
// (agent_runs.py::_effective_cancel_outcome과 동일 판정, today.py:AgentRunCancelState)
// 그대로 옮긴다. 요청된 적 없으면 필드 자체가 null(지어내지 않는다).
export type TodayAgentCancelState = 'requested' | 'acknowledged' | 'unacknowledged';

export interface TodayAgentCancel {
  requestedAt: string;
  reason: string | null;
  state: TodayAgentCancelState;
}

export interface TodayAgentProgressItem {
  runId: string;
  agentName: string;
  workItemTitle: string | null;
  status: string;
  startedAt: string;
  cancel: TodayAgentCancel | null;
}

export interface TodayPublishedByChannel {
  channelKind: string;
  count: number;
}

export interface TodayPublished {
  count: number;
  byChannel: TodayPublishedByChannel[];
}

export interface TodayUsagePlatformItem {
  connectionId: string;
  channelKind: string;
  used: number;
  limit: number;
  resetAt: string;
}

export interface TodayUsage {
  platform: TodayUsagePlatformItem[];
  adSpendMeasured: boolean;
}

/** story #3962(오늘 v3 「오늘 결과」) — story #3959(BE `landed_today`/`qa_passed_today`/
 * `open_defects`)가 이 글을 쓰는 시점 develop에 아직 없다(PR in-review, 페드루 PO 確認
 * 2026-09-16 15:36Z). 3필드 다 옵셔널 — 응답에 없으면 undefined, 있으면 `measured`가
 * false(집계 소스 부재, open_defects의 verdict_capture 미연결 등)일 수 있다. 화면은
 * undefined든 measured===false든 같은 렌더(시안 낱말 「미측정」) — 3959 착지 뒤 값이
 * 저절로 산다(이 파일도 스텁도 별도 PR도 불요, 페드루 PO 지시 그대로). */
export interface TodayCountSince {
  count: number;
  since: string | null;
  measured: true;
}

export interface TodayCountUnmeasured {
  count: null;
  since: null;
  measured: false;
}

export type TodayCount = TodayCountSince | TodayCountUnmeasured;

export interface TodaySnapshot {
  needsMe: TodayNeedsMeItem[];
  needsMeCount: number;
  agentProgress: TodayAgentProgressItem[];
  published: TodayPublished;
  usage: TodayUsage;
  landedToday?: TodayCount;
  qaPassedToday?: TodayCount;
  openDefects?: TodayCount;
}

export const EMPTY_TODAY_SNAPSHOT: TodaySnapshot = {
  needsMe: [],
  needsMeCount: 0,
  agentProgress: [],
  published: { count: 0, byChannel: [] },
  usage: { platform: [], adSpendMeasured: false },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function unwrapEnvelope(json: unknown): unknown {
  if (!isRecord(json)) return json;
  const d = json['data'];
  return d ?? json;
}

/** 낱말 표 §① «상태» 3어 매핑(PO 確定 2026-09-13 09:43Z) — kind=answer→답 대기,
 * kind=signature 또는 risk=high→서명 대기(돈·외부 발송 둘 다 — pill로 안 가르고 reason/
 * title 줄에만 맡긴다), 그 외(kind=approval&&risk=low)→승인 대기. */
export function deriveNeedsMeState(kind: unknown, risk: unknown): NeedsMeState {
  if (kind === 'answer') return 'answer';
  if (kind === 'signature' || risk === 'high') return 'signature';
  return 'approval';
}

/** source='gate'는 canonical 상세(/gates/{id})로, 그 외(hitl·workflow_step)는 기존
 * 결재함 큐(/inbox?tab=gates)로 — 둘 다 기존 라우트 재사용(새 API 0).
 * story #4241 — 게이트 상세는 그 결재의 프로젝트(`projectId`)를 `?p=`로 싣는다(다른 프로젝트 결재를 열면 셸·본문 두 세계 방지).
 * 결재함 큐는 조직 단위라 여기선 p를 싣지 않고, 소비처의 useFlatHref가 현재 프로젝트를 싣는다(이미 실은 p는 보존). */
export function hrefForNeedsMeItem(item: { source: string; id: string; projectId?: string | null }): string {
  if (item.source !== 'gate') return '/inbox?tab=gates';
  return item.projectId ? `/gates/${item.id}?p=${encodeURIComponent(item.projectId)}` : `/gates/${item.id}`;
}

function parseNeedsMeItem(raw: unknown): TodayNeedsMeItem | null {
  if (!isRecord(raw)) return null;
  const source = raw['source'];
  if (source !== 'gate' && source !== 'hitl' && source !== 'workflow_step') return null;
  // story #3962 CHANGES-2 — BE는 risk를 Literal["low","high"](today.py:39, 항상 존재)로
  // 낸다 — source와 같은 급의 핵심 판별값이라 같은 fail-closed 관례(모르는 값이면 이
  // 항목 자체를 못 그리는 걸로 취급, 지어내지 않는다).
  const risk = raw['risk'];
  if (risk !== 'low' && risk !== 'high') return null;
  const id = str(raw['source_id']);
  const workItem = isRecord(raw['work_item']) ? raw['work_item'] : null;
  const workItemId = workItem ? str(workItem['id']) : null;
  const createdAt = str(raw['created_at']);
  if (!id || !workItemId || !createdAt) return null;
  const requestedBy = isRecord(raw['requested_by']) ? raw['requested_by'] : null;
  return {
    id,
    source,
    state: deriveNeedsMeState(raw['kind'], risk),
    risk,
    workItemType: str(workItem?.['type']) ?? '',
    workItemId,
    workItemTitle: str(workItem?.['title']) ?? '',
    requestedByName: requestedBy ? str(requestedBy['name']) : null,
    reason: str(raw['reason']),
    createdAt,
    // story #3828(PR #4253) develop 착지 — 응답 값 그대로(비참여 실행은 BE가 이미 null).
    conversationId: str(raw['conversation_id']),
    recipePublish: raw['recipe_publish'] === true,
    projectId: str(raw['project_id']),
  };
}

function parseAgentCancel(raw: unknown): TodayAgentCancel | null {
  if (!isRecord(raw)) return null;
  const requestedAt = str(raw['requested_at']);
  const state = raw['state'];
  if (!requestedAt || (state !== 'requested' && state !== 'acknowledged' && state !== 'unacknowledged')) return null;
  return { requestedAt, reason: str(raw['reason']), state };
}

function parseAgentProgressItem(raw: unknown): TodayAgentProgressItem | null {
  if (!isRecord(raw)) return null;
  const runId = str(raw['run_id']);
  const agent = isRecord(raw['agent']) ? raw['agent'] : null;
  const status = str(raw['status']);
  const startedAt = str(raw['started_at']);
  if (!runId || !status || !startedAt) return null;
  const workItem = isRecord(raw['work_item']) ? raw['work_item'] : null;
  return {
    runId,
    agentName: (agent ? str(agent['name']) : null) ?? '',
    workItemTitle: workItem ? str(workItem['title']) : null,
    status,
    startedAt,
    cancel: parseAgentCancel(raw['cancel']),
  };
}

function parsePublished(raw: unknown): TodayPublished {
  if (!isRecord(raw)) return { count: 0, byChannel: [] };
  const count = num(raw['count']) ?? 0;
  const byChannelRaw = raw['by_channel'];
  const byChannel: TodayPublishedByChannel[] = [];
  if (Array.isArray(byChannelRaw)) {
    for (const row of byChannelRaw) {
      if (!isRecord(row)) continue;
      const channelKind = str(row['channel_kind']);
      const rowCount = num(row['count']);
      if (!channelKind || rowCount === null) continue;
      byChannel.push({ channelKind, count: rowCount });
    }
  }
  return { count, byChannel };
}

function parseUsage(raw: unknown): TodayUsage {
  if (!isRecord(raw)) return { platform: [], adSpendMeasured: false };
  const platformRaw = raw['platform'];
  const platform: TodayUsagePlatformItem[] = [];
  if (Array.isArray(platformRaw)) {
    for (const row of platformRaw) {
      if (!isRecord(row)) continue;
      const connectionId = str(row['connection_id']);
      const channelKind = str(row['channel_kind']);
      const used = num(row['used']);
      const limit = num(row['limit']);
      const resetAt = str(row['reset_at']);
      if (!connectionId || !channelKind || used === null || limit === null || !resetAt) continue;
      platform.push({ connectionId, channelKind, used, limit, resetAt });
    }
  }
  const adSpend = isRecord(raw['ad_spend']) ? raw['ad_spend'] : null;
  return { platform, adSpendMeasured: adSpend?.['measured'] === true };
}

/** story #3962/#3959 — `{count,since}` 또는 `{count,measured}` 응답 모양(3954 doc §AC2
 * 제안) 둘 다 받는다. 필드 자체가 응답에 없으면(3959 미착지) undefined(화면이 「미측정」
 * 자리로 안 그림) — measured===false로 명시돼 와도 같은 「미측정」 렌더로 합류(둘 다
 * "지금은 숫자가 없다"는 같은 사실이라 화면 분기를 늘리지 않는다). */
function parseTodayCount(raw: unknown): TodayCount | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw['measured'] === false) return { count: null, since: null, measured: false };
  const count = num(raw['count']);
  if (count === null) return undefined;
  return { count, since: str(raw['since']), measured: true };
}

/** 실 payload → 검증된 TodaySnapshot. 핵심 식별자 없는 항목은 지어낼 수 없어 생략
 * (no-fiction — derive-now-face.ts와 동일 원칙). */
export function parseToday(json: unknown): TodaySnapshot {
  const inner = unwrapEnvelope(json);
  if (!isRecord(inner)) return EMPTY_TODAY_SNAPSHOT;

  const needsMeRaw = inner['needs_me'];
  const needsMe: TodayNeedsMeItem[] = [];
  if (Array.isArray(needsMeRaw)) {
    for (const raw of needsMeRaw) {
      const item = parseNeedsMeItem(raw);
      if (item) needsMe.push(item);
    }
  }

  const agentProgressRaw = inner['agent_progress'];
  const agentProgress: TodayAgentProgressItem[] = [];
  if (Array.isArray(agentProgressRaw)) {
    for (const raw of agentProgressRaw) {
      const item = parseAgentProgressItem(raw);
      if (item) agentProgress.push(item);
    }
  }

  return {
    needsMe,
    needsMeCount: num(inner['needs_me_count']) ?? needsMe.length,
    agentProgress,
    published: parsePublished(inner['published_today']),
    usage: parseUsage(inner['usage']),
    landedToday: parseTodayCount(inner['landed_today']),
    qaPassedToday: parseTodayCount(inner['qa_passed_today']),
    openDefects: parseTodayCount(inner['open_defects']),
  };
}
