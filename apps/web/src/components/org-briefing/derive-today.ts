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

export interface TodayNeedsMeItem {
  id: string;
  source: 'gate' | 'hitl' | 'workflow_step';
  state: NeedsMeState;
  workItemType: string;
  workItemId: string;
  workItemTitle: string;
  requestedByName: string | null;
  reason: string | null;
  createdAt: string;
  conversationId: string | null;
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

export interface TodaySnapshot {
  needsMe: TodayNeedsMeItem[];
  needsMeCount: number;
  agentProgress: TodayAgentProgressItem[];
  published: TodayPublished;
  usage: TodayUsage;
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
 * 결재함 큐(/inbox?tab=gates)로 — 둘 다 기존 라우트 재사용(새 API 0). */
export function hrefForNeedsMeItem(item: { source: string; id: string }): string {
  return item.source === 'gate' ? `/gates/${item.id}` : '/inbox?tab=gates';
}

function parseNeedsMeItem(raw: unknown): TodayNeedsMeItem | null {
  if (!isRecord(raw)) return null;
  const source = raw['source'];
  if (source !== 'gate' && source !== 'hitl' && source !== 'workflow_step') return null;
  const id = str(raw['source_id']);
  const workItem = isRecord(raw['work_item']) ? raw['work_item'] : null;
  const workItemId = workItem ? str(workItem['id']) : null;
  const createdAt = str(raw['created_at']);
  if (!id || !workItemId || !createdAt) return null;
  const requestedBy = isRecord(raw['requested_by']) ? raw['requested_by'] : null;
  return {
    id,
    source,
    state: deriveNeedsMeState(raw['kind'], raw['risk']),
    workItemType: str(workItem?.['type']) ?? '',
    workItemId,
    workItemTitle: str(workItem?.['title']) ?? '',
    requestedByName: requestedBy ? str(requestedBy['name']) : null,
    reason: str(raw['reason']),
    createdAt,
    // story #3828(PR #4253) develop 착지 — 응답 값 그대로(비참여 실행은 BE가 이미 null).
    conversationId: str(raw['conversation_id']),
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
  };
}
