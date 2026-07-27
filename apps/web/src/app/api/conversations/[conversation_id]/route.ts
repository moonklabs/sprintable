import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ conversation_id: string }> };

/** GET — 단독 대화 메타 조회(title/type/participants/muted). story #2009: chat 상세 헤더가
 * 목록 통호출+.find() 대신 이 엔드포인트를 쓰도록 교체(BE #2286에서 participants 추가 완료). */
export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}`);
}

/** PATCH — edit a conversation (e.g. room title). Thin-proxy to the BE (EF-S2). */
export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}`);
}
