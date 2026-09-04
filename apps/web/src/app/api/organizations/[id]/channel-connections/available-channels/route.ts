import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story f30da19a(페드루 PO 확定 2026-09-04 13:xxZ) — 「연결 만들기」 버튼이 FE에서
// 하드코딩/env 분기 없이 그릴 수 있게 CHANNEL_ADAPTERS 레지스트리 파생 목록을 그대로
// pass-through(sandbox/route.ts·channel-connections/route.ts와 동형 패턴, 검증 로직
// 0). BE가 org 멤버면 에이전트도 조회 가능하도록 human 가드를 안 걸어 뒀다 — 이 BFF도
// 마찬가지로 별도 가드를 세우지 않는다(fastapi-proxy.ts가 세션/에이전트 자격을
// 동등하게 다루는 얇은 프록시라는 원칙 그대로).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/available-channels', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
