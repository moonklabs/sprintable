import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  const { name } = await params;
  const res = await fetch(
    `${FASTAPI_URL()}/api/v2/channel/files/${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${session.access_token}` } },
  );
  if (!res.ok) return new NextResponse(null, { status: res.status });

  const blob = await res.blob();
  return new NextResponse(blob, {
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream' },
  });
}
