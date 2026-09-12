import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * story #3808(Phase3·3-3 PR3/PR5a, 페드루 PO 確定 2026-09-11/12) — X 종량 API
 * 지출 월 상한 잔량 조회. BE `GET /api/v2/organizations/{org_id}/api-usage-budget`
 * → `{limit_minor, spent_minor, remaining_minor, currency, period}`(limit_minor=
 * null이면 정책 미설정) — `generation-budget/route.ts`와 완전 동형 패턴(단일 GET,
 * 검증 로직 0, !ok 전부 그대로 pass-through). PUT은 없다(한도 자체는
 * `/content-rules`의 `api_usage_budget` 필드로 설정, 이 라우트는 잔량 "계산값"만
 * 읽는 별도 축 — generation-budget/route.ts와 동일 분리 원칙).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/api-usage-budget', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
