import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// All authenticated; thin-proxy to the BE (no storage-api repo → stale-dist immune).
// Success raw → `{ data }` (dialog reads `json.data`); errors pass through.

/** GET — current public-share state ({ enabled, token, share_url }). */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/docs/${id}/share`);
}

/** POST — enable sharing (opt-in); mints an opaque token. */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/docs/${id}/share`, {
      // story #4320(까디르 QA ③) — 공유 토큰을 새로 낸다 — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
      timeLimitOnly: true,
    });
}

/** DELETE — revoke sharing; the token dies immediately. */
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/docs/${id}/share`);
}
