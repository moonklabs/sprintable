import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2631(FE 계약 doc bb733f26) — 해소 취소(오클릭 정정). BE POST /api/v2/gates/{id}/undo,
// body 없음. 인가(해소자 본인+5분 창)는 BE가 강제(403/422) — hold/void/transition과 동형
// raw passthrough, 클라이언트는 판단하지 않는다.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/undo`);
}
