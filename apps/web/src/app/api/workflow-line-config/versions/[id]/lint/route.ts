import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S34: version lint preview(POST·hard-fail 0/8). BE .../versions/{id}/lint. admin·raw.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/workflow-line-config/versions/${id}/lint`);
}
