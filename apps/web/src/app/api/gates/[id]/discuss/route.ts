import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2631(FE 계약 doc bb733f26) — «보류(논의 필요)». BE POST /api/v2/gates/{id}/discuss,
// body {reason: string}(필수, 빈 문자열 422). 인가=승인/반려와 동일 자격 — BE가 강제.
// hold/void/transition과 동형 raw passthrough.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/discuss`);
}
