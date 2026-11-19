import { PhoneFilesPage } from '@/components/desktop/phone-files-page';
import { resolveOnboardingLandingHref } from '@/lib/onboarding-landing-href';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveChatsHref, resolveNavV3Destinations } from '@/lib/nav-v3-destinations';

// story 4983 (P5 · layer 5) — the phone app's folder list of a project on the person's own computer, at its own address (see components/desktop/phone-files-page.tsx). The way out goes where the
// phone start screen's goes: the address the nav flags give for «today» (or the chat list), resolved by the server.
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

// `setup_id` + `agent_id` (the «바뀐 파일» sheet's line): the computer and the agent the person stands in — only well-formed ids are handed on
export default async function PhoneFilesRoute({ searchParams }: { searchParams: Promise<{ setup_id?: string | string[]; agent_id?: string | string[] }> }) {
  const q = await searchParams;
  const setupId = one(q.setup_id);
  const agentId = one(q.agent_id);
  const entry = setupId && agentId && UUID.test(setupId) && UUID.test(agentId) ? { setupId, agentId } : undefined;
  const flags = readNavV3FlagsFromEnv();
  const chatsHref = resolveChatsHref(flags);
  const todayHref = resolveNavV3Destinations(flags).today.path;
  return <PhoneFilesPage entry={entry} homeHref={resolveOnboardingLandingHref(flags.todayV3Enabled, todayHref, chatsHref)} />;
}
