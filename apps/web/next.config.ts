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
  // Bundle workspace packages from source (resolved via tsconfig paths) rather than
  // externalizing their built dist. The Cloud Build context uploads the host's
  // packages/*/dist (no .gcloudignore) and `next build --webpack` never rebuilds it,
  // so without this the server bundle consumed a STALE dist — e.g. an old
  // updateDocSchema that silently stripped slug/slug_locked (broke #4dd399c6 live).
  // Forcing src-transpile makes src the single source of truth for every consumer.
  transpilePackages: ['@sprintable/shared', '@sprintable/core-storage', '@sprintable/storage-api'],
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/docs/design-tokens': ['./src/app/globals.css'],
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
      // 단일 도메인 위생(45a5a006): 호스티드 app.sprintable.ai의 공개 LLM 문서는 랜딩(canonical)으로 301.
      // host 스코프로 한정해 self-hosted/dev 인스턴스는 영향받지 않고 자체 public 파일을 계속 서빙한다
      // (onboarding-form 등이 getAppOrigin()/llms.txt를 참조하므로 파일 자체는 유지). onboarding-guide.txt는
      // app(한)↔랜딩(영) 내용 상이로 별도 콘텐츠 스토리에서 처리한다.
      { source: '/llms.txt', destination: 'https://sprintable.ai/llms.txt', statusCode: 301, has: [{ type: 'host', value: 'app.sprintable.ai' }] },
      { source: '/llms-full.txt', destination: 'https://sprintable.ai/llms-full.txt', statusCode: 301, has: [{ type: 'host', value: 'app.sprintable.ai' }] },
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
