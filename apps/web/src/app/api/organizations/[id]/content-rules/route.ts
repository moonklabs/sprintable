import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * story #3472(BE #3825, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙(banned_terms·
 * require_utm·tone·taxonomy·channel_priority·brand_kit) 프록시. BE `GET/PUT
 * /api/v2/organizations/{org_id}/content-rules` → `{org_id, rules, version}`.
 * gate-config/route.ts와 동형(단일 JSON 설정, version 반환).
 *
 * PUT은 휴먼 owner만(BE `_require_owner` 엄격 — admin·에이전트 불가, 403
 * `CONTENT_RULES_OWNER_ONLY`). 검증 로직 0, !ok(403·422 `CONTENT_RULES_INVALID`)
 * 전부 그대로 pass-through.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/content-rules', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/content-rules', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
