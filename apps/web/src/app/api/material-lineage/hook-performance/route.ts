import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4089 — use-hook-performances.ts와 동형(같은 파일 상단 BFF route 신설 사유 참고,
// apps/web/src/app/api/material-lineage/route.ts).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/material-lineage/hook-performance');
}
