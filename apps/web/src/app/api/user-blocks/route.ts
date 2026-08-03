import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * story #2349 — 사용자 차단(1차: DM/멘션 축만). 계약은 디디군과 못박음(PO 2026-08-02):
 * POST   /api/v2/user-blocks  {blocked_member_id}  — 차단
 * GET    /api/v2/user-blocks                       — 내가 차단한 사용자 목록
 * BE가 blocker_member_id를 세션에서 도출한다(클라가 넘기지 않는다) — 그대로 통과시킨다.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/user-blocks');
}

export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/user-blocks');
}
