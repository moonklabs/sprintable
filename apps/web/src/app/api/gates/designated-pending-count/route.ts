import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/v2/gates/designated-pending-count 프록시 — story #3084 층1: GNB "결재" 탭
// 미확認 뱃지 소스({count}, designated_approver_id=me AND status=pending, room 무관).
export async function GET(request: NextRequest): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/gates/designated-pending-count');
}
