import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2637 — POST /api/v2/events/publish(#2633) 프록시. body = {definition_key, payload,
// extra_broadcast_member_ids?}. action_auth(human_only/role)는 이 엔드포인트가 발행 시점에
// 정의 레벨로 실제 검증한다(§범위3/#3037, 미검증 상태였던 것을 착수 中 발견→BE가 즉시 보강) —
// FE 버튼 게이팅(disabled+보조문구)은 그 위의 UX 안내일 뿐, 실 보안경계는 이 엔드포인트의 403.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/events/publish');
}
