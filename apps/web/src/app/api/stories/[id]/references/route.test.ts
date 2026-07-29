import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// story #2265(C-7) PR1b — BE list_references도 convention-A({data,meta})라
// activities/route.ts(#2247/#2564)와 같은 이중포장 위험을 처음부터 봉쇄한다(backlinks/
// route.test.ts와 동형).
const h = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams: h.proxyToFastapiWithParams }));

import { GET, POST } from './route';

const ctx = () => ({ params: Promise.resolve({ id: 'story-1' }) });
const getReq = () => new Request('http://localhost/api/stories/story-1/references?direction=outgoing');
const postReq = (body: unknown) => new Request('http://localhost/api/stories/story-1/references', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const me = () => ({ id: 'a', org_id: 'org-1', project_id: 'p1', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('GET /api/stories/[id]/references — 이중포장 회귀 방지 + proof_payload 왕복', () => {
  beforeEach(() => {
    h.getOrgProjectAuthContext.mockReset();
    h.proxyToFastapiWithParams.mockReset();
    h.getOrgProjectAuthContext.mockResolvedValue(me());
  });

  it('BE convention-A 응답이 이중포장 없이 그대로 나온다 — proof_payload 보존', async () => {
    h.proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({
        data: [{
          id: 'ref-1', form: 'proof', target_type: 'chat_message', target_id: 'msg-1',
          created_at: '2026-07-29T00:00:00Z', still_exists: true,
          proof_payload: { conversation_id: 'conv-1', start_message_id: 'msg-1', end_message_id: 'msg-1', snapshot: [] },
        }],
      }), { status: 200 }),
    );
    const res = await GET(getReq(), ctx());
    const json = await res.json() as { data: { proof_payload: { conversation_id: string } }[] };
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data[0]!.proof_payload.conversation_id).toBe('conv-1');
  });

  it('BE 에러 응답(4xx)은 그대로 통과시킨다(재포장 없음)', async () => {
    h.proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Story not found' } }), { status: 404 }),
    );
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/stories/[id]/references — 저장 왕복', () => {
  beforeEach(() => {
    h.getOrgProjectAuthContext.mockReset();
    h.proxyToFastapiWithParams.mockReset();
    h.getOrgProjectAuthContext.mockResolvedValue(me());
  });

  it('BE 201 응답을 그대로 전달한다', async () => {
    h.proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ id: 'ref-new', form: 'proof', target_type: 'chat_message', target_id: 'msg-1', created_at: '2026-07-29T00:00:00Z' }), { status: 201 }),
    );
    const res = await POST(postReq({
      target_type: 'chat_message', target_id: 'msg-1', form: 'proof',
      proof_payload: { conversation_id: 'conv-1', start_message_id: 'msg-1', end_message_id: 'msg-1', snapshot: [] },
    }), ctx());
    expect(res.status).toBe(201);
    const json = await res.json() as { data: { id: string } };
    expect(json.data.id).toBe('ref-new');
  });

  it('BE 400(잘못된 form/target 조합)을 그대로 전달한다 — 조용히 삼키지 않는다', async () => {
    h.proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: "target_type='chat_message'·form='proof' only" } }), { status: 400 }),
    );
    const res = await POST(postReq({ target_type: 'doc', target_id: 'd1', form: 'mention', proof_payload: {} }), ctx());
    expect(res.status).toBe(400);
  });
});
