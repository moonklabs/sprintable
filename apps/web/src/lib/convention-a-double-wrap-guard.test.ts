/**
 * CI 가드(2026-07-28, prod 크래시 사후) — 오늘 이 병이 세 번 났다(activities·evidence·오늘 아침
 * 디디군 스캔의 comments). 축: **BE가 이미 규약A({data,meta})를 내는데 FE 프록시가 apiSuccess로
 * 또 감싸는 자리**. 완벽한 정적분석이 아니다 — 지금 아는 「규약A로 확認된 엔드포인트 + 그
 * 프록시」 조합만 잡는다. 새 규약A 엔드포인트를 추가하면 이 목록에도 추가해야 한다(자동 탐지 아님).
 *
 * ⛔이 파일이 covers 하지 않는 것(전수 시 확認, 훑은 범위/못 훑은 범위):
 * - conversations.py(list_messages/list_message_replies): FE 프록시가 raw passthrough라
 *   해당 안 됨(이중포장 자체가 구조적으로 불가) — 스킵.
 * - docs.py(list_docs)·notifications.py(list_notifications): FE가 이 BE 엔드포인트를 아예
 *   안 쓰고 별도 내부 서비스/레포지토리를 쓴다(다른 아키텍처) — 이 클래스의 위험군이 아님, 스킵.
 * - docs.py(get_doc_backlinks): FE 프록시 자체가 아직 없음(story #2263 별건, 배선 자체가 안 됨).
 * - 미래에 새로 생기는 규약A 엔드포인트는 이 가드가 자동으로 못 잡는다 — 만들 때 이 파일에
 *   케이스를 추가하는 것이 유일한 방어선이다.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(async () => ({
    id: 'me', org_id: 'org-1', project_id: 'p1',
    rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0,
  })),
  proxyToFastapi: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({
  proxyToFastapi: h.proxyToFastapi,
  proxyToFastapiWithParams: h.proxyToFastapiWithParams,
}));

const BE_ENVELOPE = { data: [{ id: 'x1' }], meta: { has_more: false, next_cursor: null } };

function stubBeResponse() {
  const r = new Response(JSON.stringify(BE_ENVELOPE), { status: 200 });
  h.proxyToFastapi.mockResolvedValue(r.clone());
  h.proxyToFastapiWithParams.mockResolvedValue(r.clone());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertNoDoubleWrap(GET: (req: Request, ctx?: any) => Promise<Response>, ctx?: unknown) {
  stubBeResponse();
  const res = await GET(new Request('http://localhost/x'), ctx);
  const json = await res.json() as { data: unknown; meta: unknown };
  expect(Array.isArray(json.data)).toBe(true);
  expect(json.data).toEqual(BE_ENVELOPE.data);
  expect(json.meta).toEqual(BE_ENVELOPE.meta);
}

describe('규약A 엔드포인트 FE 프록시 — 이중포장 없음 가드', () => {
  it('stories/[id]/activities — #2247 이후 잔존 회귀(오늘 실제 crash) 재발 방지', async () => {
    const { GET } = await import('@/app/api/stories/[id]/activities/route');
    await assertNoDoubleWrap(GET, { params: Promise.resolve({ id: 's1' }) });
  });

  it('stories/[id]/comments — #2230/#2231 처방 유지 확認', async () => {
    const { GET } = await import('@/app/api/stories/[id]/comments/route');
    await assertNoDoubleWrap(GET, { params: Promise.resolve({ id: 's1' }) });
  });

  it('standup/history — #2248 처방 유지 확認', async () => {
    const { GET } = await import('@/app/api/standup/history/route');
    await assertNoDoubleWrap(GET);
  });
});
