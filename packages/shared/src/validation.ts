import { NextResponse } from 'next/server';
import { z } from 'zod/v4';

type RequestLike = {
  json(): Promise<unknown>;
};

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; response: NextResponse };

/**
 * Request body를 Zod 스키마로 검증하는 헬퍼.
 * - 유효: { success: true, data }
 * - 무효: { success: false, response } (표준 API 에러 형식)
 */
export async function parseBody<T extends z.ZodType>(
  request: RequestLike,
  schema: T,
): Promise<ParseResult<z.infer<T>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json({
        data: null,
        error: { code: 'INVALID_JSON', message: 'Invalid JSON body' },
        meta: null,
      }, { status: 400 } as any),
    };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return {
      success: false,
      response: NextResponse.json({
        data: null,
        error: { code: 'VALIDATION_FAILED', message: 'Validation failed', issues },
        meta: null,
      }, { status: 400 } as any),
    };
  }

  return { success: true, data: result.data };
}
