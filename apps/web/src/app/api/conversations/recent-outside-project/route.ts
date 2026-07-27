import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 현재 프로젝트 밖에서 caller가 참여 중인 최근 대화 5개(story #2168 PR-② FE).
 * BE GET /api/v2/conversations/recent-outside-project(디디, PR#2516) — 인가는 쿼리 자체가
 * project_access_valid_correlated로 거르므로 여기선 그대로 통과시킨다. */
export async function GET(request: NextRequest): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/conversations/recent-outside-project');
}
