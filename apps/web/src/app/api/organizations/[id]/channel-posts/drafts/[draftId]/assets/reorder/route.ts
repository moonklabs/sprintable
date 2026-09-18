import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string }> };

// story #3550(Phase2 BE 2/2, 페드루 PO 確定 2026-09-06) — 이미지 순서 재배열. body의
// image_ids는 항상 전체 집합·새 순서 그대로(부분 재정렬 불허 — BE가 422로 거부).
// 새 불변 버전을 만들어 반영(#3291 규율) — assets/confirm/route.ts와 동형 위임.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, draftId } = await params;
  const _r = await proxyToFastapiWithParams(
    request,
    '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/reorder',
    { id, draftId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
