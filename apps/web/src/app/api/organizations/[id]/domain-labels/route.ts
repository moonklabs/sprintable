import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3705(P0 핫픽스) — org별 표시 라벨 오버라이드 BFF 프록시 신설. 이 라우트가 없어서
// useOrgDomainLabels 훅이 BE `/api/v2/organizations/{org}/domain-labels`를 직접 호출했고,
// fetchWithAuth의 401→refresh→재시도 경로가 그 직접 호출에도 그대로 걸려 refresh 후에도
// 401이 반복 → SessionExpiredDialog(세션 만료 팝업)가 로그인 직후 뜨는 원인이었다.
// 다른 organizations/[id]/* 형제 라우트(gate-config 등)와 달리 apiSuccess({data}) 재래핑을
// 안 하고 raw passthrough를 쓴다 — 훅(use-org-domain-labels.ts)이 `res.json()`을 이미
// BE 원본 shape(GET=배열·PUT=단일 객체) 그대로 파싱하고 있어, 여기서 감싸면 그 파싱이
// 깨진다(fastapi-proxy 봉투 경계 gotcha — 소비부 shape 먼저 확認 후 결정).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/organizations/${id}/domain-labels`);
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/organizations/${id}/domain-labels`);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/organizations/${id}/domain-labels`);
}
