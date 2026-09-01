// story #3260 Phase 2 — Support Gateway(support-gateway/, story #f2a27d2a)를 브라우저가
// **직접** 호출한다(이 앱의 다른 모든 데이터 fetch와 달리 Next.js BFF 프록시를 거치지
// 않는다 — Gateway는 물리적으로 다른 Cloud Run 서비스라 fetchWithAuth의 쿠키 기반 인증이
// 애초에 안 먹는다, Bearer 위임 토큰 스킴). 계약은 support-gateway/app/schemas.py·
// routers/sessions.py(2026-08-31, 디디 PR#3648)를 그대로 따른다.
import { fetchWithAuth } from '@/lib/db/client';

export interface GatewaySession {
  id: string;
  org_id: string;
  created_at: string;
}

export interface GatewayMessage {
  id: string;
  conversation_id: string;
  role: 'customer' | 'agent';
  content: string;
  created_at: string;
}

/** story #3263 AC4 — 대화 레벨 에스컬레이션 상태(무신호 금지). null=한 번도 에스컬 안 됨,
 * 'open'=지금 사람에게 넘어가 있음(과거에 resolved된 게 있어도 열린 게 하나라도 있으면
 * open), 'resolved'=전부 해결됨. */
export type GatewayEscalationStatus = 'open' | 'resolved' | null;

export interface GatewayMessageExchange {
  customer_message: GatewayMessage;
  agent_message: GatewayMessage;
  escalated: boolean;
  escalation_status: GatewayEscalationStatus;
}

export interface GatewayMessageHistory {
  messages: GatewayMessage[];
  escalationStatus: GatewayEscalationStatus;
}

function gatewayBaseUrl(): string | null {
  const url = process.env['NEXT_PUBLIC_SUPPORT_GATEWAY_URL'];
  return url && url.length > 0 ? url : null;
}

export function isSupportGatewayConfigured(): boolean {
  return gatewayBaseUrl() !== null;
}

/** 본체 backend(POST /api/v2/support/session-token, backend/app/routers/
 * support_gateway_token.py)가 발급하는 org-스코프 위임 토큰 — 이 앱 자체 인증(쿠키)은
 * 여기까지만 쓰인다(Next.js 프록시 경유, fetchWithAuth). 이후 Gateway 호출은 전부 이
 * 토큰을 Bearer로 붙인 직접 fetch. */
async function issueDelegatedToken(): Promise<string> {
  const res = await fetchWithAuth('/api/support/session-token', { method: 'POST' });
  if (!res.ok) throw new Error(`session-token failed: HTTP ${res.status}`);
  const json = await res.json().catch(() => null) as { data?: { token?: string } } | { token?: string } | null;
  const token = (json && 'data' in json ? json.data?.token : (json as { token?: string } | null)?.token);
  if (!token) throw new Error('session-token response missing token');
  return token;
}

/** 세션 발급(멱등 — org+user당 1개, 기존 세션 재사용). 매 왕복 직전 새 위임 토큰을 발급해
 * 붙인다(token_ttl_seconds=300 만료 추적 대신 "쓸 때마다 새로 발급"으로 단순화 — 발급
 * 자체가 가벼운 본체 backend 호출이라 이 트레이드오프가 낫다, 별도 만료 타이머 불필요). */
export async function createOrResumeGatewaySession(): Promise<GatewaySession> {
  const base = gatewayBaseUrl();
  if (!base) throw new Error('Support Gateway not configured');
  const token = await issueDelegatedToken();
  const res = await fetch(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`gateway session failed: HTTP ${res.status}`);
  return (await res.json()) as GatewaySession;
}

export async function listGatewayMessages(sessionId: string): Promise<GatewayMessageHistory> {
  const base = gatewayBaseUrl();
  if (!base) throw new Error('Support Gateway not configured');
  const token = await issueDelegatedToken();
  const res = await fetch(`${base}/api/v1/sessions/${sessionId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`gateway history failed: HTTP ${res.status}`);
  const json = (await res.json()) as { messages: GatewayMessage[]; escalation_status: GatewayEscalationStatus };
  return { messages: json.messages, escalationStatus: json.escalation_status };
}

/** story #3261(오케스트레이션) 실측(Pedro, 2026-08-31) — 이 왕복은 동기 처리라 ~12초까지
 * 걸릴 수 있다(분류→비용상한 확인→Vertex 대화 루프). 호출부(use-support-widget-session.ts)가
 * 이 지연 동안 "생각 중" 지속 신호를 책임진다 — 여기는 순수 네트워크 계약만. */
export async function sendGatewayMessage(sessionId: string, content: string): Promise<GatewayMessageExchange> {
  const base = gatewayBaseUrl();
  if (!base) throw new Error('Support Gateway not configured');
  const token = await issueDelegatedToken();
  const res = await fetch(`${base}/api/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`gateway message failed: HTTP ${res.status}`);
  return (await res.json()) as GatewayMessageExchange;
}
