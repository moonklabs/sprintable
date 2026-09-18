import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3583(페드루 PO 確定 2026-09-06) — 해제. 확인 대화상자 없음(화면이 클릭 前에
// 이미 「앞으로의 유입 수집이 멈춘다·모인 값은 남는다」 문장을 상시 보인다, 유나
// §13-9⑤) — 이 라우트는 그 결정을 그대로 실행만 한다.
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/measurement-connections/ga4', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
