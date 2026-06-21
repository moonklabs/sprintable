import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S30: admin gate 무효화(void) 프록시. BE POST /api/v2/gates/{id}/void {reason}
// (admin-only is_org_owner_or_admin·voider=인증 caller·body엔 reason만). transition 프록시와 동형 raw passthrough.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/void`);
}
