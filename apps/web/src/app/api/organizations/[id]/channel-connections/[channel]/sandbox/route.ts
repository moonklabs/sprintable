import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3523(PO 실측(3523 그라운딩·page.tsx:239)·確定 2026-09-06) — 범용 샌드박스 연결
// BFF. story 5b27b32f 당시 `.../channel-connections/sandbox`(채널 고정 literal)
// BFF만 있었고, #3320 조각①이 BE에 `/instagram-sandbox`를 추가했을 때 이 FE에
// 대응 BFF를 안 만들어(channels/page.tsx가 여전히 옛 sandbox literal 경로를
// credential_kind==='none'인 항목 전부에 하드코딩 — instagram_sandbox 카드의
// 「샌드박스 연결」이 조용히 Threads류 sandbox를 만드는 오분기였다) 이 자리가
// 비어 있었다. BE도 이제 범용 `POST .../{channel}/sandbox`로 수렴했으므로 이
// BFF는 그 위임만 한다 — 검증 로직 0, CHANNEL_SANDBOX_DISABLED(404)·
// CHANNEL_SANDBOX_UNSUPPORTED(422)·CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY(403)·
// 401 전부 서버 응답 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, channel } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[channel]/sandbox', { id, channel },
  );
  if (!_r.ok) return _r;
  // 백엔드가 201로 신규 연결 생성을 알린다(구 sandbox/route.ts와 동일 이유).
  return apiSuccess(await _r.json(), undefined, _r.status);
}
