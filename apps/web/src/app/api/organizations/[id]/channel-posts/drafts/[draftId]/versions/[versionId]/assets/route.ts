import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; draftId: string; versionId: string }> };

// story #3550(Phase2 BE 2/2, 페드루 PO 確定 2026-09-06) — 캐러셀 N장 전체를 position
// 순으로. 기존 단수 `.../versions/[versionId]/asset`(대표 1장)과 별개 신규 엔드포인트
// (assets/confirm/route.ts와 동형 — 검증 로직 0).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, draftId, versionId } = await params;
  const _r = await proxyToFastapiWithParams(
    request,
    '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/versions/[versionId]/assets',
    { id, draftId, versionId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
