import { PhoneLanding } from '@/components/desktop/phone-landing';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveChatsHref } from '@/lib/nav-v3-destinations';

// story 4714 (AC3 · AC4) — where the phone app lands when it is opened (see lib/phone-landing.ts). The proxy sends the shell's own `/glance` here, with the home
// it resolved as `next`; nothing else links to it. The chat list's address is the server's own (nav flags), as the onboarding's.
export const dynamic = 'force-dynamic';

export default async function PhoneLandingPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <PhoneLanding chatsHref={resolveChatsHref(readNavV3FlagsFromEnv())} next={typeof next === 'string' ? next : null} />;
}
