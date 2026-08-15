import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2664 — org 커스텀 정의 수정/비활성. body는 부분 갱신(payload_schema/routing/
// block_template/action_auth/enabled 중 1개 이상) — 비활성화는 {enabled:false}로 표현한다
// (soft, hard delete 엔드포인트 없음 — 발행 이력이 정의를 참조하므로 BE가 의도적으로 막음).
// key는 갱신 불가 필드라 body에 없음.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/events/definitions/${id}`);
}
