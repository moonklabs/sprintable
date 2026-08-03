import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * POST /api/auth/resend-verification — story #2441.
 *
 * BE `POST /api/v2/auth/resend-verification`(auth.py)로 프록시. 인증된 사용자 본인의 이메일로만
 * 재전송하므로(get_current_user 의존), 다른 BFF 인증 라우트와 동일하게 proxyToFastapi로 sp_at
 * 쿠키를 그대로 넘긴다. rate-limit(3/hour)·중복발송 방지는 BE가 이미 처리 — 이 라우트는 그대로 통과.
 */
export async function POST(request: Request) {
  const res = await proxyToFastapi(request, '/api/v2/auth/resend-verification');
  return res;
}
