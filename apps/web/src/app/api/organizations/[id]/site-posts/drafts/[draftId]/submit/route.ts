import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3368(Phase0·마케팅운영 S4, 계약 stub) — 승인 요청(와이어프레임 S5). 백엔드 계약은
// 착지 전이지만 형상은 페드루 PO 확定(2026-09-03, 디디군 S2에 배선 지시):
//   POST /api/v2/organizations/{org}/site-posts/drafts/{draft_id}/submit
//   body(선택) {version_id} — 생략 시 서버가 최신 버전으로 간주.
//   → {gate_id, version_id, content_sha256, status:"pending"}
// role_id 해소(recipe_gate_hooks.py::_default_role_id 동형)·external_publish 게이트 pending
// 생성·content_version/content_sha256 봉인은 전부 서버 책임 — FE는 이 프록시 하나로 그대로
// 위임한다(role_id를 여기서 지어 넣지 않는다, PO 판정). 아직 백엔드 라우트가 없어 지금은
// 404가 그대로 pass-through된다 — S2 착지 후 이 파일 변경 없이 바로 동작한다.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/submit', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
