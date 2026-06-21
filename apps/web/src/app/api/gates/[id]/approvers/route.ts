import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S32: gate approver row 목록 조회 프록시(admin). BE GET /api/v2/gates/{id}/approvers
// → GateApproverResponse[](reassigned_by/at enrich). conditional-display 데이터 소스(approvers 있음=parallel→reassign 노출).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/approvers`);
}
