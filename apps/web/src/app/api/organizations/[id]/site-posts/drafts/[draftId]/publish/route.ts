import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3368(Phase0·마케팅운영 S4)/#3369(S3) — 휴먼 발행(와이어프레임 S7·S8). 페드루 PO
// 리뷰(2026-09-03) — 레거시 `POST /organizations/{org}/site-posts`(호출자가 본문 전체를
// 다시 보내는 agent 스크립트 시대 API)로 잘못 가고 있던 것을 이 draft 기반 endpoint로
// 교체한다: `POST /api/v2/organizations/{org}/site-posts/drafts/{draft_id}/publish`
// (backend/app/services/site_posts.py::publish_site_post_from_draft, story #3369). 서버가
// draft_id 하나로 최신 버전을 직접 읽어 봉인(gate.sealed_content_sha256)을 재검증하므로
// 요청 body가 필요 없다 — 화면이 본문을 다시 보낼수록 위조·구버전 발행 위험만 늘어난다.
// 성공 시 {url, published_at, version_id} — 공개 URL을 화면이 지어내지 않는다(S3 계약).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/publish', { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
