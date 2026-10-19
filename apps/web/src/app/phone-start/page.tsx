import { PhoneStartPage } from '@/components/desktop/phone-start-page';
import { resolveOnboardingLandingHref } from '@/lib/onboarding-landing-href';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveChatsHref, resolveNavV3Destinations } from '@/lib/nav-v3-destinations';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';

// story 4714 (AC3) — the phone app's start screen at its own address (see components/desktop/phone-start-page.tsx). [오늘로 가기] goes where the onboarding's
// own finish goes: the address the nav flags give for «today» (or the chat list), resolved by the server.
export const dynamic = 'force-dynamic';

export default function PhoneStartRoute() {
  const flags = readNavV3FlagsFromEnv();
  const chatsHref = resolveChatsHref(flags);
  const todayHref = resolveNavV3Destinations(flags).today.path;
  return (
    <PhoneStartPage
      chatsHref={chatsHref}
      homeHref={resolveOnboardingLandingHref(flags.todayV3Enabled, todayHref, chatsHref)}
      todayV3Enabled={flags.todayV3Enabled}
      macDownloadEnabled={isDesktopDownloadEnabled(process.env.DESKTOP_DOWNLOAD_ENABLED)}
    />
  );
}
