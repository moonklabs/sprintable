// story #4348 — 문서 자리 옮기기 어댑터(4353 · PO 23:01Z 모양 (가)). 엔드포인트가 서기 전이라 fetch를 목으로: 성공(맨 위 · data 감싸기) · 400 · 409 · 404 · 5xx · 망 오류 · 모양 틀림.
import { describe, expect, it, vi } from 'vitest';
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
import { applyReorderResult, DOC_REORDER_URL, saveDocOrder } from './doc-reorder-api';

const res = (status: number, json?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json } as unknown as Response);
const ok = { doc: { id: 'a', parent_id: 'f', sort_order: 30 }, siblings: [{ id: 'f1', sort_order: 10 }, { id: 'f2', sort_order: 20 }, { id: 'a', sort_order: 30 }] };

describe('saveDocOrder — POST /api/docs/reorder {doc_id, parent_id, after_id?}', () => {
  it('본문 그대로 POST(after_id 생략 = 맨 끝은 키 자체가 없음) · 성공 응답(맨 위 · data 감싸기)', async () => {
    const f = vi.fn(async () => res(200, ok));
    expect(await saveDocOrder({ docId: 'a', parentId: 'f' }, f as unknown as typeof fetch)).toEqual({ ok: true, ...ok });
    expect(f).toHaveBeenCalledWith(DOC_REORDER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"doc_id":"a","parent_id":"f"}' });
    const g = vi.fn(async () => res(200, { data: { doc: { id: 'c', parent_id: null, sort_order: 5 }, siblings: [{ id: 'c', sort_order: 5 }] } }));
    expect(await saveDocOrder({ docId: 'c', parentId: null, afterId: null }, g as unknown as typeof fetch)).toEqual({ ok: true, doc: { id: 'c', parent_id: null, sort_order: 5 }, siblings: [{ id: 'c', sort_order: 5 }] });
    expect(g).toHaveBeenCalledWith(DOC_REORDER_URL, expect.objectContaining({ body: '{"doc_id":"c","parent_id":null,"after_id":null}' }));
  });
  it('fetch를 안 넘기면 fetchWithAuth로 — 끌기 길(4353)이 쓰던 401 갱신 · 시간 제한 그대로', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(res(200, ok));
    expect(await saveDocOrder({ docId: 'a', parentId: 'f' })).toEqual({ ok: true, ...ok });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(DOC_REORDER_URL, expect.objectContaining({ method: 'POST', body: '{"doc_id":"a","parent_id":"f"}' }));
  });
  it('오류 셋 · 5xx · 망 오류 · 모양 틀린 성공 응답', async () => {
    const call = (r: Response | Error) => saveDocOrder({ docId: 'a', parentId: 'f', afterId: 'f1' }, (async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch);
    expect(await call(res(400))).toEqual({ ok: false, reason: 'invalid' });
    expect(await call(res(409))).toEqual({ ok: false, reason: 'stale' });
    expect(await call(res(404))).toEqual({ ok: false, reason: 'not-found' });
    expect(await call(res(500))).toEqual({ ok: false, reason: 'failed' });
    expect(await call(new Error('net'))).toEqual({ ok: false, reason: 'failed' });
    expect(await call(res(200, { siblings: [] }))).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('applyReorderResult — 응답을 로컬 트리에', () => {
  it('옮긴 문서의 부모 · 번호 + 새 부모 형제 번호 · 나머지는 같은 객체', () => {
    const tree = [
      { id: 'a', sort_order: 0, parent_id: null as string | null, title: 'A' },
      { id: 'f1', sort_order: 0, parent_id: 'f' as string | null, title: 'F1' },
      { id: 'z', sort_order: 5, parent_id: null as string | null, title: 'Z' },
    ];
    const out = applyReorderResult(tree, { ok: true, ...ok });
    expect(out[0]).toMatchObject({ id: 'a', parent_id: 'f', sort_order: 30, title: 'A' });
    expect(out[1]).toMatchObject({ id: 'f1', sort_order: 10 });
    expect(out[2]).toBe(tree[2]);
  });
});
