import type { ReactNode } from 'react';
import { getServerSession } from '@/lib/db/server';
import { TabOwnerGate } from '@/components/auth/tab-owner-gate';
import { ReclaimNoticeAlert } from '@/components/auth/reclaim-notice';
import { OnboardingSessionExpiredNotice } from '@/components/auth/onboarding-session-expired-notice';

/**
 * story #4490 — onboarding writes the person's drafts (organization draft · telemetry session) and sits outside the session
 * layouts, so it checks the browser's owner too (the fifth place, PO 05:00Z). It does not send anyone to /login: the pages
 * below keep deciding that themselves, as before; with no session there is no owner to check.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession().catch(() => null);
  return (
    <TabOwnerGate userId={session?.user_id}>
      {/* story 4725 decision 2: a person whose unproved account was reclaimed usually has no organization yet, so the sign-in lands HERE, outside the dashboard shell
          that draws the notice — it stands above the form until they close it (the server holds the mark; empty = nothing drawn) */}
      {/* only with a session: the notice reads /api/auth/me through fetchWithAuth, and a 401 there (an anonymous visit to a page that decides about login itself) would
          start a refresh and tell the whole app the session ended (codex 01a15051) */}
      {session ? (
        <div className="mx-auto w-full max-w-md px-4 pt-4 empty:hidden">
          <ReclaimNoticeAlert />
        </div>
      ) : null}
      {/* story 4766 AC5: the session ending is said here too (the dashboard shell's dialog does not reach this page) */}
      {session ? (
        <div className="mx-auto w-full max-w-md px-4 pt-4 empty:hidden">
          <OnboardingSessionExpiredNotice />
        </div>
      ) : null}
      {children}
    </TabOwnerGate>
  );
}
