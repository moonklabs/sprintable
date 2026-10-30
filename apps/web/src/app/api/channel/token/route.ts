import { NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { fastapiBaseUrl } from '@/lib/fastapi-url';

export async function GET(): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();
  // story 4824: the page opens its websocket straight to the backend, whose address is only known to the server when the app picks its ports at launch
  return NextResponse.json({ token: session.access_token, backend_origin: fastapiBaseUrl() });
}
