import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
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
