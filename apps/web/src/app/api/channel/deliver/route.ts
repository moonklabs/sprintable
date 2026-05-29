import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  const body = await request.text();
  const res = await fetch(
    `${FASTAPI_URL()}/api/v2/channel/deliver?token=${encodeURIComponent(session.access_token)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
  );
  const resBody = await res.text();
  return new NextResponse(resBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
}
