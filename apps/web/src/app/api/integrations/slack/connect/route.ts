import { NextResponse } from 'next/server';
import { fastapiCall } from '@/lib/fastapi-proxy';
import { ApiErrors } from '@/lib/api-response';
import { getServerSession } from '@/lib/db/server';

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
    const status = err instanceof Error && err.message.includes('403') ? 403 : 400;
    return NextResponse.json(
      { data: null, error: { code: 'FAILED', message: String(err) }, meta: null },
      { status },
    );
  }
}
