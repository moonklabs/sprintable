import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// 2505d27d: GET /api/v2/team-presence 프록시 — org 전 에이전트 presence(연결)+working(작업) 집계.
// #1356(team_presence.py)·폴링 GET. 팀 presence 패널이 소비. (/working 프록시 패턴 동형)
export async function GET(request: NextRequest): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/team-presence');
}
