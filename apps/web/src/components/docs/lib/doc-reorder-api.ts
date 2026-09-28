/**
 * story #4348 — 문서 자리 옮기기 저장(4353 · PO 23:01Z 모양 (가) · 미르코에게 보냄)의 **얇은 어댑터 한 곳**.
 * - `POST /api/docs/reorder` 본문 `{ doc_id, parent_id: uuid | null, after_id?: uuid | null }`
 *   - `after_id` = 그 형제 **바로 뒤** · `null` = 맨 앞 · **생략** = 맨 끝. 형제 집합과 번호는 서버가 안다(클라이언트는 옮긴 문서 하나만 말함).
 *   - 까닭: 문서 트리는 20개씩 페이지로 받아 형제 **전부**를 모를 수 있지만, 페이지는 앞에서부터 차례로 받아 받은 목록은 늘 전체의 앞부분이라
 *     이웃(바로 앞 · 바로 뒤)은 확실히 안다.
 * - 응답 `{ doc: { id, parent_id, sort_order }, siblings: [{ id, sort_order }] }` = 새 부모의 형제 전부(서버가 매긴 번호).
 * - 오류: 400 모양 · 순환 = `invalid` · 409 `after_id`가 그 부모의 형제가 아님(그 사이 옮겨짐) = `stale` · 404 접근 불가 = `not-found` ·
 *   그 밖(망 오류 · 5xx) = `failed`. 409는 새 문구 없이 `moveFailed` + 트리 다시 읽기(PO).
 */
import { reorderRequestBody, type DocMovePlan } from '../doc-move-plan';
import { fetchWithAuth } from '@/lib/db/client';

export type ReorderResult =
  | { ok: true; doc: { id: string; parent_id: string | null; sort_order: number }; siblings: Array<{ id: string; sort_order: number }> }
  | { ok: false; reason: 'invalid' | 'stale' | 'not-found' | 'failed' };

export const DOC_REORDER_URL = '/api/docs/reorder';

// 본문은 계획 모듈(doc-move-plan.ts reorderRequestBody) 한 곳이 만든다 — 끌기 · «⋮» 메뉴가 같은 계획 → 같은 본문(story #4348 · 4353).
// 기본 fetch = fetchWithAuth(401 → 토큰 갱신 · 시간 제한 · 세션 만료 신호) — 끌기 길이 4353에서 쓰던 그대로.
export async function saveDocOrder(plan: DocMovePlan, fetchImpl: typeof fetch = fetchWithAuth): Promise<ReorderResult> {
  let res: Response;
  try {
    res = await fetchImpl(DOC_REORDER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reorderRequestBody(plan)) });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (res.status === 400) return { ok: false, reason: 'invalid' };
  if (res.status === 409) return { ok: false, reason: 'stale' };
  if (res.status === 404) return { ok: false, reason: 'not-found' };
  if (!res.ok) return { ok: false, reason: 'failed' };
  try {
    const json = (await res.json()) as Record<string, unknown>;
    // BFF가 apiSuccess로 감싸면 data 안에, 그대로 넘기면 맨 위에 — 둘 다 받는다.
    const payload = (json && typeof json.data === 'object' && json.data ? json.data : json) as { doc?: unknown; siblings?: unknown };
    const doc = payload.doc as { id?: unknown; parent_id?: unknown; sort_order?: unknown } | undefined;
    const siblings = Array.isArray(payload.siblings)
      ? (payload.siblings as Array<{ id?: unknown; sort_order?: unknown }>).filter((d) => typeof d?.id === 'string' && typeof d?.sort_order === 'number') as Array<{ id: string; sort_order: number }>
      : null;
    if (!doc || typeof doc.id !== 'string' || typeof doc.sort_order !== 'number' || !siblings) return { ok: false, reason: 'failed' };
    return { ok: true, doc: { id: doc.id, parent_id: typeof doc.parent_id === 'string' ? doc.parent_id : null, sort_order: doc.sort_order }, siblings };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** 성공 응답을 로컬 트리에 반영 — 옮긴 문서의 부모 · 번호 + 새 부모 형제들의 번호. 응답에 없는 문서는 같은 객체 그대로. */
export function applyReorderResult<T extends { id: string; sort_order: number; parent_id: string | null }>(docs: T[], result: Extract<ReorderResult, { ok: true }>): T[] {
  const order = new Map(result.siblings.map((d) => [d.id, d.sort_order]));
  return docs.map((d) => {
    if (d.id === result.doc.id) return { ...d, parent_id: result.doc.parent_id, sort_order: result.doc.sort_order };
    const n = order.get(d.id);
    return n === undefined ? d : { ...d, sort_order: n };
  });
}
