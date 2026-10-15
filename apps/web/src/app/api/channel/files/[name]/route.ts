import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { backendFetch } from '@/lib/backend-fetch';
import { channelFileHeaders } from '@/lib/channel-file-headers';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  const { name } = await params;
  const res = await backendFetch(
    `${FASTAPI_URL()}/api/v2/channel/files/${encodeURIComponent(name)}`,
    { request, headers: { Authorization: `Bearer ${session.access_token}` } },
  );
  if (!res.ok) return new NextResponse(null, { status: res.status });

  const blob = await res.blob();
  // #4532: an allowed type in place, anything else a download — never the reported type as it is (html · svg ran in our origin)
  return new NextResponse(blob, { headers: channelFileHeaders(res.headers.get('Content-Type')) });
}
