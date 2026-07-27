import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #1954(P1a-S4) 게이트 canonical 상세 — 단건 조회. BE 계약(story #1970, 디디 오너)이
// GET /api/v2/gates/{id}를 신설하기 전까지는 404 패스스루(proxyToFastapi가 non-2xx 그대로 전달) —
// BE 배포 즉시 이 프록시가 그대로 동작한다(FE 쪽 변경 불요).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}`);
}
