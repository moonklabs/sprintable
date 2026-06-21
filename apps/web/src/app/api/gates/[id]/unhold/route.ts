import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S31: admin gate 재개(unhold) 프록시. BE POST /api/v2/gates/{id}/unhold — held→pending 복귀(SLA 재개).
// 디디 BE 병렬·머지되면 정합. void/transition 동형 raw passthrough.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/unhold`);
}
