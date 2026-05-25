import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const _CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // GCS 파일, Google/GitHub 아바타 이미지
  "img-src 'self' data: blob: https://storage.googleapis.com https://*.googleusercontent.com https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  // API 호출 (self = Next.js rewrites 경유, googleapis = Cloud KMS/AI)
  "connect-src 'self' https://*.googleapis.com",
  "media-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  // OAuth 리다이렉트 대상
  "form-action 'self' https://accounts.google.com https://github.com",
].join('; ');

const _SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: _CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  // Allow dev server access from non-localhost origins (e.g. Tailscale, LAN)
  // Set NEXT_DEV_ALLOWED_ORIGINS=host1,host2 in .env.local to enable
  allowedDevOrigins: process.env['NEXT_DEV_ALLOWED_ORIGINS']?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/(authenticated)/docs/design-tokens': ['./src/app/globals.css'],
  },
  devIndicators: {
    position: 'bottom-right',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: _SECURITY_HEADERS,
      },
    ];
  },
  async redirects() {
    return [
      { source: '/memos', destination: '/inbox', permanent: true },
      { source: '/memos/:path*', destination: '/inbox', permanent: true },
    ];
  },
  async rewrites() {
    const fastapiUrl = process.env.NEXT_PUBLIC_FASTAPI_URL ?? 'http://localhost:8000';
    return [
      {
        source: '/api/v2/:path*',
        destination: `${fastapiUrl}/api/v2/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
