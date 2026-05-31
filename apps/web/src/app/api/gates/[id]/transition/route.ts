import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/transition`);
}
