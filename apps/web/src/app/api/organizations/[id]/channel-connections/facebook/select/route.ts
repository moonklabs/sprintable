import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3549(3547 BE·디디 PR#3904 실측, PO 確定 2026-09-06) — Facebook Page 「선택
// 대기」의 마지막 한 걸음. BE 라우트는 `POST /{org_id}/channel-connections/facebook/
// select`로 **리터럴 고정**이다 — `facebook_sandbox` 콜백도 같은 이 한 경로로
// select를 보낸다(어느 channel의 pending인지는 URL이 아니라 body.pending_id로 DB에
// 저장된 pending.channel에서 되찾는다, channel_connections.py::facebook_select_page_
// endpoint 실측). 그래서 이 BFF도 `[channel]` 제네릭이 아니라 리터럴 `facebook`
// 세그먼트로 둔다 — 제네릭으로 두면 "channel 값이 무엇이든 그 경로로 간다"는 거짓
// 신호를 준다.
//
// facebook_sandbox 카드 UI(§13-8 재사용 여부)는 이 스토리(3549) 스코프 밖으로
// 남겨 둔다(PO 확定 없음) — 이 라우트 자체는 pending.channel이 sandbox든 아니든
// 그대로 통하므로 후속에서 카드만 얹으면 된다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/facebook/select', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
