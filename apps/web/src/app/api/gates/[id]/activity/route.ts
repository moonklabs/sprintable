import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2975 AC4(PO 확定 2026-08-24) — 사람 결재 행위(approve/reject/undo/void/override) 이력.
// github-check-events(위 폴더 형제)와 대칭인 gate-scope sub-resource. GateEvidence가 지연
// 로드하는 소량 read-only 리스트.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/activity`);
}
