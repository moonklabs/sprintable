import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

// story e0c1b24c — org 게이트 정책(posture·merge_gate_default_approver_member_id) BFF.
// 백엔드 GET/PUT /api/v2/gate-config/policy(backend/app/routers/hitl_config.py)는 org를
// 헤더(X-Org-Id)/JWT로 해소하므로 동적 [id] 파라미터가 없다(gates/route.ts와 동형, org
// 하위 [id]/gate-config와는 다름). GET은 정책 미설정 시 null을 그대로 반환(지어내지 않음).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/gate-config/policy');
}

export async function PUT(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/gate-config/policy');
}
