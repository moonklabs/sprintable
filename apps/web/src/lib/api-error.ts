import { NotFoundError, ForbiddenError } from '@/services/sprint';
import { RevokedApiKeyError } from './auth-api-key';
import { apiError } from './api-response';

export function handleApiError(err: unknown) {
  if (err instanceof RevokedApiKeyError) {
    return apiError('REVOKED_API_KEY', err.message, 401);
  }
  if (err instanceof NotFoundError) {
    return apiError('NOT_FOUND', err.message, 404);
  }
  if (err instanceof ForbiddenError) {
    return apiError('FORBIDDEN', err.message, 403);
  }

  // DB/Postgrest 에러 코드 직접 매핑
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code === '42501') {
      return apiError('PERMISSION_DENIED', 'Permission denied', 403);
    }
    if (code === 'PGRST116') {
      return apiError('NOT_FOUND', 'Not found', 404);
    }
    // story #2488 — mapApiError(packages/storage-api·apps/web/src/lib/fastapi-proxy.ts)가
    // 이제 backend error.code·status를 던지는 에러 객체에 실어 보존한다 — 여기서 그
    // 값을 JSON 응답에 그대로 실어 브라우저까지 도달시킨다(#2484/#2485 error.code
    // 하드닝의 전제 fix). 위 두 Postgrest 코드와 겹칠 일 없음(backend code는 항상
    // SCREAMING_SNAKE_CASE 문자열, Postgrest는 5자리 숫자 코드).
    if (typeof code === 'string' && 'status' in err && typeof (err as { status?: unknown }).status === 'number') {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return apiError(code, message, (err as { status: number }).status);
    }
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  return apiError('INTERNAL_ERROR', message, 400);
}
