import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/transition`, {
    // story #4320(까디르 QA ①) — 레시피 게이트 승인이면 그 자리에서 발행(동기로 못 기다림 · 후속 카드) — 시한은 표 한 곳(bff-route-timeouts · 근거 백엔드 파일:줄).
    timeoutMs: LONG_ROUTES.gateTransition.bffMs,
  });
}
