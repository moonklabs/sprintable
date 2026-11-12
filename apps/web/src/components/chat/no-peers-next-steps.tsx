'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button as DsButton } from '@/components/ds/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { isNoProjectAtAll, projectsUnknownBecauseFailed } from '@/app/(authenticated)/chats/no-project';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * story 4906 (defect ① of the customer lap) — a NEW organization's first conversation was a dead end: /chats said «start a new conversation», the «+» window listed nobody
 * to talk to (0 rows, «대화 시작» off) and nothing said what to do next. The only people in a new organization are the person themself (and the system publisher, which is
 * not somebody to talk to). The next step already exists on other screens — add an agent (`/organization/workforce?tab=recruit`) or invite a teammate (`/organization/members`) —
 * so this only SAYS it and LINKS there (no new feature). Only an admin / owner can do either, so a plain member is told who can (no link they cannot use).
 */

/** the people one can start a room WITH: the organization's active members, minus me and minus the system publisher (the same filter the «새 대화» window uses) */
export function usePeopleToTalkTo(): { state: 'loading' | 'failed' | 'ready'; count: number } {
  const { currentTeamMemberId } = useDashboardContext();
  const [read, setRead] = useState<{ state: 'loading' | 'failed' | 'ready'; ids: string[] }>({ state: 'loading', ids: [] });
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/members?is_active=true')
      .then((r) => { if (!r.ok) throw new Error(`members ${r.status}`); return r.json(); })
      .then((json) => {
        const list = ((json?.data ?? []) as Array<{ id: string; runtime_type?: string | null }>).filter((m) => !isSystemPublisher(m.runtime_type));
        if (!cancelled) setRead({ state: 'ready', ids: list.map((m) => m.id) });
      })
      .catch(() => { if (!cancelled) setRead({ state: 'failed', ids: [] }); });
    return () => { cancelled = true; };
  }, []);
  const count = currentTeamMemberId ? read.ids.filter((id) => id !== currentTeamMemberId).length : read.ids.length;
  return { state: read.state, count };
}

/** who the person is here decides the next step they can take: an admin / owner adds an agent (needs a project first — an agent belongs to one) or invites; a member can do neither */
function useNextStepKind(): 'admin' | 'admin-no-project' | 'member' {
  const ctx = useDashboardContext();
  const role = (ctx.orgMemberships ?? []).find((o) => o.orgId === ctx.orgId)?.role; // a context that does not carry the list (a partial one) is not an admin
  if (role !== 'admin' && role !== 'owner') return 'member';
  // the person's projects could not be READ: that is not «no project» (they may have some) — no claim about projects, the recruit tab tells the failed state apart
  if (projectsUnknownBecauseFailed(ctx)) return 'admin';
  return isNoProjectAtAll(ctx) ? 'admin-no-project' : 'admin';
}

/** the sentence + (admin / owner) the links; `withText={false}` leaves out the sentence when the caller draws it (the empty state passes it as its description) */
export function NoPeersNextSteps({ withText = true }: { withText?: boolean }) {
  const t = useTranslations('chats');
  const flatHref = useFlatHref();
  const kind = useNextStepKind();
  return (
    <div className="flex flex-col items-center gap-3" data-testid="chat-no-peers">
      {withText ? <p className="m-0 text-center text-sm leading-6 text-muted-foreground">{noPeersBody(t, kind)}</p> : null}
      {kind !== 'member' ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {kind === 'admin-no-project' ? (
            // an agent belongs to a project and there is none yet: go straight to where one is made (the recruit tab would only say so and send the person here — one press more)
            <DsButton asChild variant="primary" size="md"><Link href={flatHref('/settings?tab=projects')} data-testid="chat-no-peers-create-project">{t('noPeersCreateProject')}</Link></DsButton>
          ) : (
            <DsButton asChild variant="primary" size="md"><Link href={flatHref('/organization/workforce?tab=recruit')} data-testid="chat-no-peers-add-agent">{t('noPeersAddAgent')}</Link></DsButton>
          )}
          <DsButton asChild variant="secondary" size="md"><Link href={flatHref('/organization/members')} data-testid="chat-no-peers-invite">{t('noPeersInvite')}</Link></DsButton>
        </div>
      ) : null}
    </div>
  );
}

function noPeersBody(t: (k: string) => string, kind: 'admin' | 'admin-no-project' | 'member'): string {
  return kind === 'member' ? t('noPeersBodyMember') : kind === 'admin-no-project' ? t('noPeersBodyNoProject') : t('noPeersBody');
}

/** the list rail's empty state: «대화가 없어요» + «새 대화를 시작해보세요» — and, when nobody is there to talk to yet, the next steps instead of an invitation that leads nowhere */
export function ChatListEmptyState() {
  const t = useTranslations('chats');
  const peers = usePeopleToTalkTo();
  const kind = useNextStepKind();
  // a read that has not answered (or failed) is not «nobody»: the ordinary empty state stays
  if (peers.state === 'ready' && peers.count === 0) {
    return <EmptyState title={t('noConversations')} description={noPeersBody(t, kind)} action={<NoPeersNextSteps withText={false} />} className="w-full max-w-xs" />;
  }
  return <EmptyState title={t('noConversations')} description={t('startNewConversation')} className="w-full max-w-xs" />;
}
