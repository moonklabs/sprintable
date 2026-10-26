import type { ReactNode } from 'react';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';
import { desktopDownloadBucket } from '@/lib/desktop-downloads';
import { MacAppOfferProvider } from './mac-app-offer';

// story #4763 AC6 — the server side of the first screen's «Mac 앱 받기»: whether the download exists on this deployment (the same switch as /desktop's, read on the server only) — and since «받기» is now the file itself
// (/desktop/get/macos), a configured bucket too: the switch on with no bucket would draw a link that can only answer 502.
export default function LoginLayout({ children }: { children: ReactNode }) {
  return <MacAppOfferProvider enabled={isDesktopDownloadEnabled(process.env.DESKTOP_DOWNLOAD_ENABLED) && desktopDownloadBucket() !== null}>{children}</MacAppOfferProvider>;
}
