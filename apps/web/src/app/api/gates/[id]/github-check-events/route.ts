import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2814 2단(§5-② 그라운딩·BE story #2815/PR#3245) — GitHub check 발행/재-pending/해소 원장
// 조회. GateEvidence가 재-pending 사유 표시를 위해 지연 로드하는 소량 read-only 리스트.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/github-check-events`);
}
