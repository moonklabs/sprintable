import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** POST — issue a fresh token; the previous one dies (leak defense). */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/docs/${id}/share/regenerate`, {
    // story #4320(까디르 QA ③) — 공유 토큰을 재발급(옛 토큰 폐기) — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
    timeLimitOnly: true,
  });
}
