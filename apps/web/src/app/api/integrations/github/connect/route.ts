import { NextResponse } from 'next/server';
import { fastapiCall } from '@/lib/fastapi-proxy';
import { ApiErrors } from '@/lib/api-response';
import { getServerSession } from '@/lib/db/server';
import { ForbiddenError } from '@sprintable/core-storage';

// E-GHAPP Bot-S: GitHub App(봇) 설치 시작 — org admin이 여기로 오면 backend가 org-bound signed state로
// GitHub App install URL을 발급하고, 그 URL로 302 리다이렉트한다(설치는 GitHub에서 진행). Route Handler
// (Server Action 아님) — 외부 리다이렉트.
export async function GET() {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  try {
    const result = await fastapiCall<{ install_url: string }>(
      'GET',
      '/api/v2/integrations/github/install/start',
      session.access_token,
    );
    return NextResponse.redirect(result.install_url);
  } catch (err: unknown) {
    // story #2500 — 그라운딩 확認: fastapiCall(→packages/storage-api)의 mapApiError는
    // 403을 이미 ForbiddenError instanceof로 정확히 분류해 던진다(require_admin이 raise
    // 하는 실제 메시지 "Admin role required"는 "403"이라는 부분문자열을 포함 안 해
    // .includes('403')는 항상 false — 진짜 403도 조용히 400으로 격하되던 버그).
    const status = err instanceof ForbiddenError ? 403 : 400;
    return NextResponse.json(
      { data: null, error: { code: 'FAILED', message: String(err) }, meta: null },
      { status },
    );
  }
}
