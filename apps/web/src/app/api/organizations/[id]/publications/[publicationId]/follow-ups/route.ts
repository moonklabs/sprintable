import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; publicationId: string }> };

// story #3503 — BE #3502(fd57310d4, origin/feat/3502-insights-board-api, 이 파일 작성
// 시점 develop 미착지) `POST /api/v2/organizations/{org_id}/publications/{publication_id}/
// follow-ups` 위임. 사람 전용(FOLLOW_UP_CREATE_HUMAN_ONLY 403 — BE _require_human이 이미
// 강제, 이 BFF는 role을 더 좁히지 않는다, campaigns/route.ts와 동일 관례).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, publicationId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publications/[publicationId]/follow-ups', { id, publicationId },
  );
  if (!_r.ok) return _r;
  // 백엔드가 201로 생성을 알린다(브리프 명시) — apiSuccess 기본값(200)에 묻히면 소비부가
  // 상태 코드로 "새로 만들어짐"을 못 구분한다(campaigns POST와 동일 이유).
  return apiSuccess(await _r.json(), undefined, _r.status);
}
