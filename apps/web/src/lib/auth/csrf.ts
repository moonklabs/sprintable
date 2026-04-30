import { NextResponse } from 'next/server';
import { resolveAppUrl } from '@/services/app-url';

/** POST 요청의 Origin 헤더가 앱 도메인과 일치하는지 검증 */
export function verifyCsrfOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('Origin');
  if (!origin) {
    const referer = request.headers.get('Referer');
    if (referer) {
      const appOrigin = resolveAppUrl(null);
      if (!referer.startsWith(appOrigin) && !referer.startsWith('http://localhost:')) {
        return NextResponse.json(
          { error: { code: 'CSRF_FORBIDDEN', message: 'Invalid request origin' } },
          { status: 403 },
        );
      }
    }
    return null;
  }

  const appOrigin = resolveAppUrl(null);
  const allowedOrigins = [appOrigin, 'http://localhost:3000', 'http://localhost:3108'];

  if (!allowedOrigins.some((allowed) => origin === allowed)) {
    return NextResponse.json(
      { error: { code: 'CSRF_FORBIDDEN', message: 'Invalid request origin' } },
      { status: 403 },
    );
  }

  return null;
}
