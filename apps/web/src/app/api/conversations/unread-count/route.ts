import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/v2/conversations/unread-count 프록시 — story #1992: GNB 채팅 unread 총합(count-only).
// caller 전 참여 대화(페이지네이션 무관) unread_count SUM → {count: int}. story #1977이 GNB
// 3표면(사이드바 채팅 항목+모바일 4탭 채팅 탭) 배지 소스로 소비.
export async function GET(request: NextRequest): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/conversations/unread-count');
}
