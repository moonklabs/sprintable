import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Allow dev server access from non-localhost origins (e.g. Tailscale, LAN)
  // Set NEXT_DEV_ALLOWED_ORIGINS=host1,host2 in .env.local to enable
  allowedDevOrigins: process.env['NEXT_DEV_ALLOWED_ORIGINS']?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  devIndicators: {
    position: 'bottom-right',
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
