// story #4253(까디르 codex 01a0d35f P1 · PO 12:55Z) — 게이트 단건 조회의 공용 읽기. 계약 = BE GateResponse 날 JSON(라이브 근거: PO live34 · dev
// GET /api/gates/{id} 최상위 키 source · id · org_id · project_id … · data 키 없음). {data} envelope를 성공으로 읽으면 목이 실제 모양과 어긋나도
// 초록이 되어 미리보기 본문 빈 채(이 PR 전부터)를 다시 가린다 — 그래서 envelope는 error다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGateById } from './fetch-gate';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string) => (globalThis.fetch as unknown as (u: string) => Promise<Response>)(url) }));

function stub(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchGateById — 날 GateResponse 한 모양', () => {
  it('⭐날 JSON이면 ok + 그 게이트', async () => {
    stub(200, { id: 'g-1', status: 'pending', project_id: 'proj-C' });
    await expect(fetchGateById('g-1')).resolves.toEqual({ kind: 'ok', gate: { id: 'g-1', status: 'pending', project_id: 'proj-C' } });
  });

  it('⭐{data} envelope는 실제 계약이 아니다 — error(목이 실제 모양과 어긋나면 바로 드러나게)', async () => {
    stub(200, { data: { id: 'g-1', status: 'pending' } });
    await expect(fetchGateById('g-1')).resolves.toEqual({ kind: 'error' });
  });

  it('404 → not-found · 그 밖 실패 → error', async () => {
    stub(404, { detail: 'Gate not found' });
    await expect(fetchGateById('g-1')).resolves.toEqual({ kind: 'not-found' });
    stub(500, null);
    await expect(fetchGateById('g-1')).resolves.toEqual({ kind: 'error' });
  });

  it('네트워크 예외도 error(호출처가 따로 try/catch 안 해도 된다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(fetchGateById('g-1')).resolves.toEqual({ kind: 'error' });
  });
});
