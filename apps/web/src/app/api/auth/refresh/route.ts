import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/refresh */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(SP_RT_COOKIE)?.value;
  if (!refreshToken) {
    return NextResponse.json({ error: { code: 'NO_REFRESH_TOKEN', message: 'No refresh token' } }, { status: 401 });
  }

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string }; error?: { code: string; message: string } };
  if (!fastapiRes.ok || !json.data) {
    // story e5225c0a(P0) 3차 재진단(산티아고 prod gcloud 실측 근본 확定): 이 route는
    // PUBLIC_PREFIX('/api/auth/')라 proxy.ts 미들웨어를 안 거쳐 별도 실패 경로다(1차 갭, #2185에서
    // 봉합) — 그런데 그 #2185 자체도 `res.cookies.delete(name)`(bare form, domain 없음)를 썼다.
    // prod FE Cloud Run엔 `NEXT_PUBLIC_COOKIE_DOMAIN=app.sprintable.ai`가 Secret Manager로
    // 설정돼 있어(dev엔 없음 — dev 검증이 못 잡은 이유) cookieBase()가 SET 시 Domain 속성을
    // 붙인다. 삭제가 그 Domain 없이 나가면 브라우저가 "다른 쿠키"로 취급해 **삭제가 조용히
    // no-op** — 죽은 sp_rt가 그대로 남아 매분 재시도·401 무한 재생산이 지속됐다(2차 근본).
    // fix: SET과 완전히 동일한 속성(...cookieBase())으로 값만 빈 문자열+maxAge=0 — 브라우저가
    // 반드시 동일 쿠키로 매칭해 덮어쓰게 한다(bare delete()의 domain drift 클래스 자체를 제거).
    const res = NextResponse.json(
      { error: json.error ?? { code: 'REFRESH_FAILED', message: 'Token refresh failed' } },
      { status: fastapiRes.status },
    );
    res.cookies.set(SP_AT_COOKIE, '', { ...cookieBase(), maxAge: 0 });
    res.cookies.set(SP_RT_COOKIE, '', { ...cookieBase(), maxAge: 0 });
    return res;
  }

  const { access_token, refresh_token } = json.data;
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  return res;
}
