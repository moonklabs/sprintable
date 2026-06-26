import { proxyToFastapi } from '@/lib/fastapi-proxy';

// DELETE /api/assets/[id] → FastAPI DELETE /api/v2/assets/{id}
// S5 affordance: BE delete(S7)가 아직 미착지일 수 있어 비-2xx는 클라이언트가 graceful 처리.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/assets/${id}`);
}
