import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  devIndicators: {
    position: 'bottom-right',
  },
  serverExternalPackages: ['@sprintable/storage-sqlite'],
};

export default withNextIntl(nextConfig);
