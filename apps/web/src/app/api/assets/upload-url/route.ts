import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/assets/upload-url { filename, content_type, project_id? }
//   → FastAPI POST /api/v2/assets/upload-url
//   → { upload_url, object_path, expires_at, required_put_headers } (story #3249)
// 에러(비-2xx)는 raw 통과(FE 서비스가 res.ok로 분기)·성공은 apiSuccess로 감싸되 상태 보존.
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/assets/upload-url');
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
