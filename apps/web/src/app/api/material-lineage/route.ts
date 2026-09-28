import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4089(P0 핫픽스, story #3705와 동일 결함 클래스) — use-material-lineage.ts가 이
// BFF route 없이 BE `/api/v2/material-lineage`를 직접 호출하고 있었다(다른 모든 엔드포인트는
// `/api/...` BFF proxy 경유). fetchWithAuth의 401→refresh→재시도 경로가 그 직접 호출에도
// 그대로 걸려 refresh 후에도 401이 반복 → SessionExpiredDialog가 게이트 상세·스토리 화면
// 진입 직후 뜨는 원인이었다(리허설 1호 실측, 휴먼 세션은 정상). domain-labels 선례와 동형
// raw passthrough — 훅이 BE 원본 shape(배열)을 그대로 파싱한다.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/material-lineage');
}
