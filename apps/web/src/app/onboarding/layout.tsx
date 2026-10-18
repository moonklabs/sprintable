import type { ReactNode } from 'react';
import { getServerSession } from '@/lib/db/server';
import { TabOwnerGate } from '@/components/auth/tab-owner-gate';
import { ReclaimNoticeAlert } from '@/components/auth/reclaim-notice';

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
      <div className="mx-auto w-full max-w-md px-4 pt-4 empty:hidden">
        <ReclaimNoticeAlert />
      </div>
      {children}
    </TabOwnerGate>
  );
}
