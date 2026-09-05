import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; commandId: string }> };

/**
 * story #3479(BE 3476, 페드루 PO 確定 2026-09-05) — 발행 명령 재시도. site_post·
 * channel_post 공용(BE가 command_id 하나로 대상을 안다, content_kind 구분자는
 * story e4fc29fa 조각③c). channel-connections/wordpress/route.ts와 동형 —
 * 검증 로직 0, !ok 전부 그대로 pass-through.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id, commandId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publication-commands/[commandId]/retry', { id, commandId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
