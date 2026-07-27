import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { token } = await params;
  // 라이브 재현(2026-07-21, story #2383 배포검수 중 발견) — 이 라우트가 public 옵션 없이
  // proxyToFastapi를 호출해 미인증 요청을 무조건 401로 막고 있었다(fastapi-proxy.ts:92-94).
  // 초대 프리뷰는 정의상 "아직 계정이 없는 신규 사용자"가 보는 화면이라 미인증이 기본 상태다
  // — 이 라우트 신설(#857) 이후 한 번도 고쳐진 적 없는 원 결함(git log 단일 커밋 확認).
  // POST .../accept는 로그인/가입 완료 후에만 호출되므로 인증 유지가 맞다(그대로 둠).
  const _r = await proxyToFastapiWithParams(request, '/api/v2/invites/[token]', { token }, { public: true });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
