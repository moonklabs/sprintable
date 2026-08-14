import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2637 — POST /api/v2/events/publish(#2633) 프록시. body = {definition_key, payload,
// extra_broadcast_member_ids?}. ⚠️action_auth(human_only/role)는 이 엔드포인트가 아직 검증
// 안 함(그라운딩 확認, PO에 보고) — FE 버튼 게이팅은 UX 안내일 뿐 실 보안경계가 아니다.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/events/publish');
}
