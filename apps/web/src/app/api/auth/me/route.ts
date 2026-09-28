import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** story #3195 — BE app.routers.auth.get_auth_me(AuthMeResponse)를 서빙. `/api/me`
 * (BE `me.py::get_me`, TeamMember 필수)와 달리 JWT claims만으로 응답해 org/TeamMember가
 * 없어도(=온보딩 1/4 진행 중인 유저) 200을 낸다 — email_verified·org_id를 org-less
 * 컨텍스트에서도 신뢰성 있게 읽어야 하는 소비처(onboarding-form.tsx·verify-email/page.tsx)
 * 전용 경로. `/api/me`는 그대로(다른 소비처들의 org/project-scoped 계약 무변경). */
export async function GET(request: Request) {
  try {
    // story #4178(까디르 QA·PO 판단) — BE /auth/me는 X-Org-Id를 받으면 그 org 가입을 확인해
    // 비가입이면 403을 낸다. 웹 소비처(onboarding-form·verify-email)는 member_id·email_verified·
    // org_id 유무만 읽어 JWT org 기준이면 충분한데, org 탈퇴 뒤 탭 인터셉터에 옛 org가 남은 채
    // SPA로 이 화면에 오면 헤더가 실려 403 → draft 복원·인증 감지를 건너뛴다. 그래서 이 BFF만
    // 헤더를 떨군다(org 규칙 통일은 BE를 직접 부르는 외부 클라이언트용으로 그대로 산다).
    const headers = new Headers(request.headers);
    headers.delete('x-org-id');
    const forwarded = new Request(request.url, { method: request.method, headers });
    const res = await proxyToFastapi(forwarded, '/api/v2/auth/me');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
