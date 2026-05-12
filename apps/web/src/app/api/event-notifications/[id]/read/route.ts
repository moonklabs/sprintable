import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/event-notifications/[id]/read', { id });
}
