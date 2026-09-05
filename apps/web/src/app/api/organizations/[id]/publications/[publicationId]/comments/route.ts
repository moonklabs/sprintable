import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; publicationId: string }> };

// story #3517(Phase2·FE, BE #3865 조각①, PO 確定 2026-09-05) — `publications/
// [publicationId]/insights`(#3499)와 동형 미러 패턴. limit/offset은 원 요청의
// querystring을 그대로 얹어 보낸다(proxyToFastapi가 url.search를 forward — 이 BFF는
// 검증·조립 0). 응답 {last_collected_at, comments[]}을 그대로 위임 — 세 얼굴(§22-②)
// 판정은 소비부(comments-section.tsx) 몫.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, publicationId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publications/[publicationId]/comments', { id, publicationId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
