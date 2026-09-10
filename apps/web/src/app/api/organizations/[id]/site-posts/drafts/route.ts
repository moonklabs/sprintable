import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3368(Phase0·마케팅운영 S4) — 글 관리 목록·상신 흐름의 BFF. 백엔드
// backend/app/routers/site_posts.py::post_site_post_draft_version /
// list_site_post_drafts_endpoint(story #3365 + 후속 목록 엔드포인트, PO 확定
// 2026-09-03)를 그대로 위임할 뿐 검증 로직 0 — org-connectors 라우트(story 4180f67f)와
// 동형 패턴.
//
// GET  — 조직의 초안 목록(limit/offset 쿼리를 그대로 forward, proxyToFastapi가
//        url.search를 통째로 넘긴다). 응답은 [{draft_id, work_item_id, slug, lang,
//        title, current_version, latest_author_kind, updated_at}] — 게이트/봉인 해시는
//        S2 착지 전까지 없다(목록 화면은 이 필드 부재를 'draft'로 파생한다,
//        components/content/post-status.ts 참조).
// POST — 신규 초안 생성 또는 기존 초안에 새 버전 추가. 요청 body에 draft_id가 없다 —
//        서버가 (org_id, work_item_id, slug)로 기존 초안을 찾아 매칭한다(PR#3731 계약,
//        페드루 정정 2026-09-03). slug는 첫 버전 뒤 편집 화면에서 잠근다(새 초안 분기
//        방지) — 그 잠금은 이 라우트가 아니라 편집 화면(S3, 후속 스토리) 책임이다.
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/site-posts/drafts', { id });
  if (!_r.ok) return _r;
  // story #3744(페드루 스티어 2026-09-09) → #3761(유나 낱말 定 정정) — X-Total-Count를
  // meta.totalCount로 실어 보낸다(정본, goals/tasks 관례 — `total`은 은퇴, 한 개념에
  // 이름 둘 금지). Number.isFinite로 명시 가드해 헤더가 숫자가 아니면 null(모름), NaN을
  // JSON 직렬화해 거짓 false로 착시하지 않는다.
  const totalHeader = _r.headers.get('x-total-count');
  const parsed = totalHeader === null ? null : Number(totalHeader);
  const totalCount = parsed !== null && Number.isFinite(parsed) ? parsed : null;
  return apiSuccess(await _r.json(), { totalCount });
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/site-posts/drafts', { id });
  if (!_r.ok) return _r;
  // 백엔드가 201로 신규/버전추가를 알린다 — apiSuccess 기본값(200)에 묻히면 소비부가 상태
  // 코드로 "신규 버전 생성됨"을 구분 못 한다.
  return apiSuccess(await _r.json(), undefined, _r.status);
}
