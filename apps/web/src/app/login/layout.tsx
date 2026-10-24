import type { ReactNode } from 'react';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';
import { MacAppOfferProvider } from './mac-app-offer';

// story #4763 AC6 — the server side of the first screen's «Mac 앱 받기»: whether the download exists on this deployment (the same switch as /desktop's, read on the server only).
export default function LoginLayout({ children }: { children: ReactNode }) {
  return <MacAppOfferProvider enabled={isDesktopDownloadEnabled(process.env.DESKTOP_DOWNLOAD_ENABLED)}>{children}</MacAppOfferProvider>;
}
