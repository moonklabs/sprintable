import { NextResponse } from 'next/server';
import { fastapiCall } from '@/lib/fastapi-proxy';
import { ApiErrors } from '@/lib/api-response';
import { getServerSession } from '@/lib/db/server';
import { ForbiddenError } from '@sprintable/core-storage';

export async function GET() {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  try {
    const result = await fastapiCall<{ data: { url: string } }>(
      'GET',
      '/api/v2/integrations/slack/connect',
      session.access_token,
    );
    return NextResponse.redirect(result.data.url);
  } catch (err: unknown) {
    // story #2500 — 그라운딩 확認: fastapiCall(→packages/storage-api)의 mapApiError는
    // 403을 이미 ForbiddenError instanceof로 정확히 분류해 던진다(slack_connect의
    // _err("FORBIDDEN","Admin access required",403) 메시지도 "403"이라는 부분문자열을
    // 포함 안 해 .includes('403')는 항상 false — 진짜 403도 조용히 400으로 격하되던 버그).
    const status = err instanceof ForbiddenError ? 403 : 400;
    return NextResponse.json(
      { data: null, error: { code: 'FAILED', message: String(err) }, meta: null },
      { status },
    );
  }
}
