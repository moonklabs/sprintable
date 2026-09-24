import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #4253(까디르 codex 01a0d35f P1 · PO 12:55Z) — 게이트 단건 조회(GET /api/gates/{id})의 **공용** 읽기.
 * `/api/gates/[id]` 라우트는 proxyToFastapi(감싸지 않음)라 BE `GateResponse`(gates.py response_model) **날 JSON**이 온다 — `{data}` envelope가
 * 아니다. 예전엔 호출처마다 모양을 따로 가정해(`json.data`만 · `json?.data ?? json` · `'data' in json`) 한 곳(embed-card 미리보기)은 늘 비어 있었다.
 * 계약이 한쪽(날 JSON)으로 정해졌으니 여기 한 곳만 그 모양을 안다. 호출처는 결과 종류로 갈린다(404 = not-found · 그 밖 실패 = error).
 */
export type FetchGateResult<T> = { kind: 'ok'; gate: T } | { kind: 'not-found' } | { kind: 'error' };

export async function fetchGateById<T extends { id: string } = { id: string }>(gateId: string): Promise<FetchGateResult<T>> {
  try {
    const res = await fetchWithAuth(`/api/gates/${gateId}`);
    if (res.status === 404) return { kind: 'not-found' };
    if (!res.ok) return { kind: 'error' };
    const gate = (await res.json().catch(() => null)) as T | null;
    return gate && typeof gate === 'object' && typeof gate.id === 'string' ? { kind: 'ok', gate } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}
