import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * story #3500(BE #3498, PO 確定 2026-09-05 — BE 미착지, 계약만 고정) — 생성 비용
 * 한도(크레딧 게이트) 잔량 조회. BE `GET /api/v2/organizations/{org_id}/
 * generation-budget` → `{limit_minor, spent_minor, remaining_minor, currency,
 * period}`(limit_minor=null이면 정책 미설정). content-rules/route.ts와 동형
 * 패턴(단일 GET, 검증 로직 0, !ok 전부 그대로 pass-through) — PUT은 없다(한도
 * 자체는 `/content-rules`의 `generation_budget` 필드로 설정, 이 라우트는 잔량
 * "계산값"만 읽는 별도 축).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/generation-budget', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
