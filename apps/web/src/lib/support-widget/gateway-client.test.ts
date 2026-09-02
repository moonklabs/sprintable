// @vitest-environment jsdom
//
// story #3260 2차(카디르 QA 축① 지적, 2026-08-31) — use-support-widget-session.test.tsx는
// gateway-client 모듈 전체를 vi.mock으로 통째로 갈아치워서, 이 파일 안의 실 !res.ok→throw
// 매핑 로직 자체는 어디서도 실행되지 않았다(그 매핑 코드가 통째로 삭제돼도 CI는 계속
// green이었을 자리). 이 파일은 그 갭을 겨냥 — fetchWithAuth(세션-token 발급)만 목하고
// Gateway 응답(global fetch)은 실 코드 경로로 태운다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

// gatewayBaseUrl()이 process.env를 매 호출 시점에 읽으므로(모듈 로드 시점이 아님) 정적
// import로 충분 — env는 각 테스트의 beforeEach가 설정한다.
import {
  endGatewayConversation,
  listGatewayConversations,
  listGatewayMessages,
  sendGatewayMessage,
  startNewGatewayConversation,
} from './gateway-client';

const ENV_KEY = 'NEXT_PUBLIC_SUPPORT_GATEWAY_URL';
const GATEWAY_URL = 'https://support-gateway-dev.example';

beforeEach(() => {
  process.env[ENV_KEY] = GATEWAY_URL;
  fetchWithAuthMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { token: 'delegated-token', expires_in: 300 } }),
  });
});

afterEach(() => {
  delete process.env[ENV_KEY];
  vi.unstubAllGlobals();
});

describe('sendGatewayMessage — story #3260 2차 카디르 QA 축① 회귀가드', () => {
  it('Gateway가 5xx를 돌려주면 HTTP 상태를 담아 throw한다(no-fiction — 조용히 삼키지 않음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(sendGatewayMessage('sess-1', '안녕하세요')).rejects.toThrow('HTTP 500');
  });

  it('네트워크 자체가 죽으면(fetch reject) 그대로 전파한다(가짜 성공으로 삼키지 않음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(sendGatewayMessage('sess-1', '안녕하세요')).rejects.toThrow('Failed to fetch');
  });
});

describe('story #3276 — 상담 수명주기 클라이언트 함수 회귀가드(같은 !res.ok→throw 갭)', () => {
  it('listGatewayMessages — conversation_id를 주면 쿼리 파라미터로 실제 요청 URL에 실린다', async () => {
    const fetchMock = vi.fn(async (_url: unknown) => ({
      ok: true,
      json: async () => ({ messages: [], escalation_status: null, conversation_id: 'conv-1', ended_at: '2026-09-01T00:00:00Z' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await listGatewayMessages('sess-1', 'conv-1');
    expect(result.conversationId).toBe('conv-1');
    expect(result.endedAt).toBe('2026-09-01T00:00:00Z');
    const calledUrl = fetchMock.mock.calls[0]![0] as URL;
    expect(calledUrl.toString()).toContain('conversation_id=conv-1');
  });

  it('listGatewayMessages — conversation_id 생략 시 쿼리 파라미터 없이 호출된다(하위호환 — 현재 활성 상담)', async () => {
    const fetchMock = vi.fn(async (_url: unknown) => ({
      ok: true,
      json: async () => ({ messages: [], escalation_status: null, conversation_id: null, ended_at: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await listGatewayMessages('sess-1');
    const calledUrl = fetchMock.mock.calls[0]![0] as URL;
    expect(calledUrl.toString()).not.toContain('conversation_id');
  });

  it('listGatewayConversations — 5xx면 throw한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(listGatewayConversations('sess-1')).rejects.toThrow('HTTP 500');
  });

  it('startNewGatewayConversation — 성공 시 서버가 돌려준 새 상담을 그대로 반환한다', async () => {
    const conv = { id: 'conv-2', created_at: 't', ended_at: null, escalation_status: null };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => conv })));
    await expect(startNewGatewayConversation('sess-1')).resolves.toEqual(conv);
  });

  it('startNewGatewayConversation — 5xx면 throw한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(startNewGatewayConversation('sess-1')).rejects.toThrow('HTTP 500');
  });

  it('endGatewayConversation — 5xx면 throw한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(endGatewayConversation('sess-1', 'conv-1')).rejects.toThrow('HTTP 500');
  });

  it('endGatewayConversation — 성공 시 ended_at이 채워진 상담을 반환한다', async () => {
    const conv = { id: 'conv-1', created_at: 't', ended_at: 't2', escalation_status: 'open' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => conv })));
    await expect(endGatewayConversation('sess-1', 'conv-1')).resolves.toEqual(conv);
  });
});
