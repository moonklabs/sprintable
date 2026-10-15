import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4427 — GET /api/v2/invites/mine 프록시(4833 · 사람 세션): 로그인한 사람의 인증된 이메일로 온 대기 초대(토큰 없음).
// 데스크톱 설정 페이지가 조직 없는 사람에게 «새 조직»을 보일지 · 초대 안내를 보일지 가른다. `[token]`보다 먼저 잡히는 고정 경로.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/invites/mine');
}
