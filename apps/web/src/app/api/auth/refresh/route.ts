import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { safeJsonParse } from '@/lib/api-response';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// story #2449 AC1(계측, 페드루 PO 지시 2026-09-16) — 클라이언트(refresh-diagnostics.ts)가
// 실어 보낸 진단 3종. 요청 body가 비어있거나(onboarding-form.tsx의 무-body 호출 2곳·기존
// 테스트의 '{}') JSON이 아니면 조용히 없음 취급(그 호출부들의 회귀가 아니라 이 계측 자체가
// optional이라는 계약).
interface RefreshRequestBody {
  diagnostics?: { visibility_state?: string; idle_ms?: number; tab_count?: number };
}

async function parseRequestBody(request: Request): Promise<RefreshRequestBody> {
  try {
    return (await request.json()) as RefreshRequestBody;
  } catch {
    return {};
  }
}

/** POST /api/auth/refresh */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const { diagnostics } = await parseRequestBody(request);

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

  const json = await safeJsonParse(fastapiRes) as { data?: { access_token: string; refresh_token: string }; error?: { code: string; message: string } };
  if (!fastapiRes.ok || !json.data) {
    if (fastapiRes.status === 401) {
      // story #2449 AC1 — BFF 로그 1줄로 클라이언트 신호를 남긴다(PII 0). BE(auth.py)의
      // delta_since_revoke_s·successor_used·ua와 짝지어, 다음 하드 401이 「동시경합
      // straggler」인지 「탭이 오래 회전된 RT를 들고 있었다」인지 수동 상관 없이 갈린다.
      // CHANGES(카디르 codex 읽기 검수, 페드루 PO 채택 2026-09-16 13:28Z) — correlation_key
      // 없이는 이 로그 줄과 BE 로그 줄을 자동으로 못 짝지었다. BE가 X-Auth-Correlation
      // 헤더(token_hash[:12], 비밀값 아님)로 실어 보내는 값을 그대로 반영.
      console.warn('[auth-refresh] hard 401', {
        correlation_key: fastapiRes.headers.get('x-auth-correlation'),
        visibility_state: diagnostics?.visibility_state ?? null,
        idle_ms: diagnostics?.idle_ms ?? null,
        tab_count: diagnostics?.tab_count ?? null,
      });
    }
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
