import { NextResponse } from 'next/server';
import { resolveAppUrl } from '@/services/app-url';

function isTrustedOrigin(origin: string, requestHost: string | null): boolean {
  try {
    // Same-host check: Origin의 host가 요청 서버의 host와 동일하면 신뢰
    // 이 방식은 Tailscale, ngrok, Cloudflare Tunnel 등 어떤 포워딩 도구도 자동으로 허용
    if (requestHost && new URL(origin).host === requestHost) return true;
  } catch {
    return false;
  }

  const appOrigin = resolveAppUrl(null);
  const extraOrigins = (process.env['EXTRA_CSRF_ORIGINS'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowedOrigins = [appOrigin, 'http://localhost:3000', 'http://localhost:3108', ...extraOrigins];

  return allowedOrigins.some((allowed) => origin === allowed);
}

/** POST 요청의 Origin 헤더가 앱 도메인과 일치하는지 검증 */
export function verifyCsrfOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('Origin');
  const requestHost = request.headers.get('host');

  if (!origin) {
    const referer = request.headers.get('Referer');
    if (referer) {
      try {
        const refererHost = new URL(referer).host;
        if (requestHost && refererHost === requestHost) return null;
      } catch { /* fall through to legacy check */ }

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

  if (!isTrustedOrigin(origin, requestHost)) {
    return NextResponse.json(
      { error: { code: 'CSRF_FORBIDDEN', message: 'Invalid request origin' } },
      { status: 403 },
    );
  }

  return null;
}
