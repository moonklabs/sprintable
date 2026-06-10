import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** POST — issue a fresh token; the previous one dies (leak defense). */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/docs/${id}/share/regenerate`);
}
