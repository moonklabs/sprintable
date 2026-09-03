import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3376, 그라운딩 §10-1/§10-3 — owner 전용. 파괴적 행동(§6 "예약된 것을 함께
// 죽인다") — 확인 다이얼로그는 화면 몫, 이 라우트는 BE 응답을 그대로 전달만 한다.
//
// ⚠️폴더명은 `[channel]`이지만 실제로 이 URL 세그먼트에 담기는 값은 channel 문자열이
// 아니라 connection_id(UUID)다 — Next.js가 같은 깊이(channel-connections/ 바로 아래)의
// 형제 동적 세그먼트에 서로 다른 슬러그 이름을 허용하지 않아(PO 실측: dev 서버 자체가
// 기동 못 함, "different slug names for the same dynamic path") authorize·callback·
// app-credentials(진짜 channel)와 폴더명을 통일했다. 라우트 내부에서만 원래 의미대로
// `connectionId`로 되짚어 쓴다 — proxyToFastapiWithParams에 넘기는 값·BE 경로 둘 다
// 무변화(이 파일 하나의 변수명 문제일 뿐, 계약은 그대로).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, channel: connectionId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/disconnect', { id, connectionId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
