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
import { sendGatewayMessage } from './gateway-client';

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
