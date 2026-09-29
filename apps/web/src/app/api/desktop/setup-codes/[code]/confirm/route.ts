import { apiError } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4427 — POST /api/v2/desktop/setup-codes/{code}/confirm 프록시(4424 · org owner/admin 사람 세션).
// body = {project_id, recipe_id, roles:[{stage, runtime}], workdir_hint}. 코드 모양은 여기서 한 번 더 막는다(경로에
// 다른 조각이 섞이지 않게) — 판단은 BE(verifier · 만료 · 이미 확인됨)가 한다.
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  if (!CODE_RE.test(code)) {
    return apiError('code_expired', 'unknown setup code', 410);
  }
  return proxyToFastapi(request, `/api/v2/desktop/setup-codes/${code}/confirm`);
}
