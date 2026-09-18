import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story 1db41045(#3457, 유나 정적 판정·PO 확認 2026-09-04 17:50Z) — campaign 붙이기/
// 해제/변경을 site-posts 저장 POST(새 버전 생성)로 하면 _reseal_gate_on_new_version이
// 본문 해시를 안 보고 approved→pending·reapproval_required로 되돌려 버린다(승인이
// 무름). 디디 BE 소형 후속: 이 PATCH는 버전을 안 만들고 게이트를 안 건드린다 —
// campaign_id 하나만 바꾼다. 검증 로직 0, 422(CAMPAIGN_NOT_FOUND) 그대로 pass-through.
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/campaign', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
