import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3402(Phase1·마케팅운영) — 채널 포스트 목록·초안 생성 BFF. site-posts/drafts/route.ts
// 와 동형 패턴(검증 로직 0, 그대로 위임) — 백엔드는 backend/app/routers/channel_posts.py::
// list_channel_post_drafts_endpoint / post_channel_post_draft_version(story #3374·#3394).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/channel-posts/drafts', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/channel-posts/drafts', { id });
  if (!_r.ok) return _r;
  // 백엔드가 201로 신규/버전추가를 알린다(site-posts/drafts/route.ts와 동일 이유).
  return apiSuccess(await _r.json(), undefined, _r.status);
}
