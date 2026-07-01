import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/loops/[id]/artifacts → FastAPI GET /api/v2/loops/{id}/artifacts (variant_group-grouped, raw LoopArtifactVariantGroup[]).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/loops/${id}/artifacts`);
}
