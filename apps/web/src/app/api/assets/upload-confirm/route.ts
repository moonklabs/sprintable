import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/assets/upload-confirm { object_path, filename, content_type?, project_id?, folder_id? }
//   → FastAPI POST /api/v2/assets/upload-confirm (201, AssetResponse) (story #3249)
// head_object로 서버가 실크기·존재 실측 후 Asset row 등록(source_type=manual). 201 보존.
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/assets/upload-confirm');
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
