import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // OSS 빌드에서는 SaaS 전용 코드 경로의 stub 타입 에러를 무시한다.
  typescript: process.env.OSS_MODE === 'true' ? { ignoreBuildErrors: true } : {},
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  devIndicators: {
    position: 'bottom-right',
  },
  serverExternalPackages: ['@sprintable/storage-sqlite'],
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
