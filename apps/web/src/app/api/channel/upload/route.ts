import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  const formData = await request.formData();
  const res = await backendFetch(
    `${FASTAPI_URL()}/api/v2/channel/upload?token=${encodeURIComponent(session.access_token)}`,
    { request, method: 'POST', body: formData },
  );
  const resBody = await res.text();
  return new NextResponse(resBody, { status: res.status });
}
