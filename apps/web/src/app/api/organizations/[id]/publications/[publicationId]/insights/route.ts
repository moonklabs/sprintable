import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; publicationId: string }> };

// story #3499(Phase2·FE, 게시물 성과 표면 1차) — BE #3497/PR#3844 위임. publicationId는
// site_post(hosted_site=SitePost.id·외부=ChannelPublication.id)·channel_post(최신
// ChannelPublication.id) 세 자리 어디서 왔든 동일 축(PO 確定 2026-09-05, publication_id
// 필드명 고정 — BE #3844 조각4, 이 PR 작성 시점엔 미착지). 스냅샷 목록을 그대로 위임,
// 값 조립·판정 0.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, publicationId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publications/[publicationId]/insights', { id, publicationId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
