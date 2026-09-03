// story #3376 — PR#3736(1d21a3d5b, backend/app/routers/channel_connections.py) 실 응답
// 스키마 그대로(그라운딩 §10 재확認, 2026-09-03). 토큰·secret 필드는 어느 응답에도 없다 —
// FE가 다룰 값 자체가 없다(추측이 아니라 실 스키마에 없음을 diff로 확인).

export interface ChannelConnectionResponse {
  id: string;
  channel: string;
  account_id: string;
  account_label: string | null;
  credential_kind: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
  token_expires_at: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
  can_auto_refresh: boolean;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthorizeResponse {
  url: string;
  state: string;
}

export interface TestConnectionResponse {
  ok: boolean;
  account?: Record<string, unknown> | null;
  error?: string | null;
}

export interface AppCredentialsStatusResponse {
  configured: boolean;
  app_id_suffix: string | null;
  updated_by: string | null;
  updated_at: string | null;
  effective_source: 'org' | 'platform' | 'none';
}

/** PUT 응답 — GET과 모양이 다르다(app_id 전체값을 돌려준다, 방금 owner가 직접 입력한
 * 값이라 secret이 아니다 — GET의 app_id_suffix와 혼동 금지). */
export interface AppCredentialsPutResponse {
  configured: boolean;
  app_id: string;
}
