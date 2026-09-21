import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #4101 — 목록 그대로 pass-through(휴먼 org 멤버 전원, BE가 인가 판정·
// credentials 필드는 응답 DTO에 아예 없다). channel-connections/route.ts와 동형
// (story #3376).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/generation-connectors', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

// story #4101 CHANGES-2(페드루 PO 리뷰, 2026-09-21) — 이 POST 라우트 자체가 없어
// dev에서 누구도(에이전트 키는 BE가 403·PO 세션은 BFF 쿠키만 거친다) 첫 연산
// 커넥터를 등록할 길이 없었다. channel-connections/sandbox/route.ts와 동형 —
// 검증 로직 0, BE 응답(201·422·403 등) 그대로 pass-through(credentials는 요청
// 바디에만 실려 그대로 전달·이 라우트가 로깅·가공하지 않는다).
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/generation-connectors', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
