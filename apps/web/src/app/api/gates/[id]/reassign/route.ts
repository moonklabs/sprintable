import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S32: gate 결재자 재지정 프록시(admin). BE POST /api/v2/gates/{id}/reassign
// {new_approver_id, old_approver_id?, reason?} → 갱신된 GateApproverResponse[]. reassigner=BE 강제·gate status 불변.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/reassign`);
}
