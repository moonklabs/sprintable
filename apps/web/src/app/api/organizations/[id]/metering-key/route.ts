import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3354(마케팅자동화·측정)·#3540 FE 후속(페드루 PO 確定 2026-09-06) — beacon 공개
// 키 조회. BE는 키가 없으면 최초 발급한다(멱등 — org 멤버 이상, 이 값은 비밀이 아니다,
// 랜딩 JS에 그대로 박히는 공개 식별자). 그대로 pass-through.
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/metering-key', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
