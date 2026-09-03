import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §8-1 순서 5번,
// 와이어프레임 S7·S8) — 발행. backend/app/routers/site_posts.py::post_site_post
// (story #3352/#3360, S1이 휴먼 전용 가드 추가) 그대로 위임. 승인된 최신 버전에서만
// 성공한다 — 게이트 미승인·해시 불일치(S3 착지 後)는 403/409로 그대로 pass-through되고
// 화면(content/[draftId]/page.tsx)이 원문을 접어 보존한 채 사람 말로 렌더한다(api-error.ts,
// S10 규율).
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/site-posts', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
