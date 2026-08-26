import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3001 — 지정 결재자 위임(튕겨내기) 프록시. BE POST /api/v2/gates/{id}/delegate
// {new_approver_member_id} → 갱신된 GateResponse. 인가(현재 지정자 본인만·403)는 BE 강제,
// 이 라우트는 순수 프록시(reassign 라우트와 동형).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/delegate`);
}
