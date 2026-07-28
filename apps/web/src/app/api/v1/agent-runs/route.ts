import { apiSuccess, type ApiMeta } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    // #2230/#2231 동형 이중포장 fix: BE가 {data,meta}(규약 A)를 낸다 — 그대로 apiSuccess(json)에
    // 넘기면 통째로 다시 data 필드에 얹혀 이중포장되고, 바깥 meta는 항상 null이 된다(agent-runs-list.tsx
    // 「더 보기」가 그래서 구조적으로 죽어 있었다). data/meta를 풀어서 넘긴다.
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    // 단건 생성 응답이라 meta는 없지만, 같은 이중포장 위험(data.data)을 동일하게 막는다.
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (error) { return handleApiError(error); }
}
