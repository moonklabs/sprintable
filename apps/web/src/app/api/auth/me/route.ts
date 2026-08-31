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
    const res = await proxyToFastapi(request, '/api/v2/auth/me');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
