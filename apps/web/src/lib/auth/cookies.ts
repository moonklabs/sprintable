/** APP_BASE_URL 또는 NEXT_PUBLIC_APP_URL 기준으로 Secure 쿠키 여부 결정.
 *  HTTP(localhost, Tailscale, ngrok 등)에서는 false, HTTPS에서는 true.
 */
function isSecureScheme(): boolean {
  const appUrl = process.env['APP_BASE_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'] ?? '';
  return appUrl.startsWith('https://');
}

export function cookieBase(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  domain?: string;
} {
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return {
    httpOnly: true,
    secure: isSecureScheme(),
    sameSite: 'lax',
    path: '/',
    ...(domain ? { domain } : {}),
  };
}
