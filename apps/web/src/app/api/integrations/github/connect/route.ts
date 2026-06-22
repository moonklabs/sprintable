import { NextResponse } from 'next/server';
import { fastapiCall } from '@/lib/fastapi-proxy';
import { ApiErrors } from '@/lib/api-response';
import { getServerSession } from '@/lib/db/server';

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
    const status = err instanceof Error && err.message.includes('403') ? 403 : 400;
    return NextResponse.json(
      { data: null, error: { code: 'FAILED', message: String(err) }, meta: null },
      { status },
    );
  }
}
