'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ds/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { useFlatHref } from '@/hooks/use-flat-href';

interface PlannedOrg { id: string; name: string }
interface BlockingOrg extends PlannedOrg { reason: 'other_members' | 'active_subscription' }
interface OrgPlan { closing: PlannedOrg[]; blocked: BlockingOrg[] }

/** story #4752 — the confirmation of «계정 삭제».
 *
 *  What it said before: nothing, on every failure but `REAUTHENTICATION_REQUIRED` (an `alert`) — a person who pressed «삭제 확인» and got a 403 or a 500 saw the dialog vanish and could
 *  not tell whether the account was gone. Now every end says something, and the dialog stays open on a failure so the person can try again.
 *
 *  What happens to the person's organizations (AC4, PO rule): the window asks the server first (`/api/account/delete-preview`) and shows it before «삭제 확인» —
 *  - an organization where nobody else is active CLOSES with the account («함께 닫히는 조직: …»);
 *  - an organization with other people where the person is the only owner, or one that would close but has an active subscription, BLOCKS the deletion: each is named with what to do and a
 *    way to the screen that does it (members: hand over ownership · billing: cancel the subscription), and «삭제 확인» is off until it is dealt with.
 *  The server is the judge either way: the same list comes back as 409 `ORG_BLOCKS_ACCOUNT_DELETE` if the preview was stale or could not be read.
 *
 *  Ends: ok → login page (the server signed the person out of everything); 404 → no such live account any more (already deleted): the same way out; `REAUTHENTICATION_REQUIRED` →
 *  «다시 로그인한 뒤 삭제해 주세요»; 401 → «세션이 만료됐어요 …»; 409 with organizations → the blocking list; anything else, or the network → «삭제하지 못했어요 …». */
export function DeleteAccountDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const flatHref = useFlatHref();   // flat destinations carry the project (story #4226 ratchet)
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<OrgPlan>({ closing: [], blocked: [] });
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null); // the window opens on «취소» — an irreversible action is never the one a stray Enter lands on

  // The preview is read once when the window opens. A failure to read it is not shown: the deletion still works and the server answers with the same list if something blocks.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/account/delete-preview');
        if (!res.ok) return;
        const json = await res.json().catch(() => null) as { data?: Partial<OrgPlan> } | null;
        if (alive && json?.data) setPlan({ closing: json.data.closing ?? [], blocked: json.data.blocked ?? [] });
      } catch { /* the server decides at «삭제 확인» */ }
    })();
    return () => { alive = false; };
  }, []);

  const confirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/account/delete', { method: 'POST' });
      if (res.ok || res.status === 404) { onDeleted(); return; }
      const json = await res.json().catch(() => null) as { error?: { code?: string; orgs?: BlockingOrg[] } } | null;
      if (json?.error?.code === 'REAUTHENTICATION_REQUIRED') setError(t('reauthRequired'));
      else if (json?.error?.code === 'ORG_BLOCKS_ACCOUNT_DELETE' && Array.isArray(json.error.orgs) && json.error.orgs.length > 0) setPlan((p) => ({ closing: p.closing.filter((c) => !json.error!.orgs!.some((b) => b.id === c.id)), blocked: json.error!.orgs! }));   // an organization the server now blocks is no longer one that «closes»
      else if (res.status === 401) setError(t('deleteSessionEnded'));
      else setError(t('deleteFailed'));
    } catch {
      setError(t('deleteFailed'));
    }
    setDeleting(false);
  };

  const blocked = plan.blocked.length > 0;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !deleting) onClose(); }}>
      <DialogContent className="max-w-sm" showCloseButton={false} initialFocus={cancelRef} aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId} className="text-ds-failed">{t('deleteConfirmTitle')}</DialogTitle>
          <DialogDescription>{t('deleteConfirmDesc')}</DialogDescription>
        </DialogHeader>
        {plan.closing.length > 0 ? (
          <p className="text-ds-body text-ds-ink [overflow-wrap:anywhere]" data-testid="delete-account-closing-orgs">
            {t('deleteClosingOrgs', { names: plan.closing.map((o) => o.name).join(', ') })}
          </p>
        ) : null}
        {blocked ? (
          <div className="flex flex-col gap-2" data-testid="delete-account-blocking-orgs">
            <Banner tone="failed">{t('deleteOwnedOrgsTitle')}</Banner>
            <ul className="list-disc space-y-1 pl-5 text-ds-body text-ds-ink [overflow-wrap:anywhere]">
              {plan.blocked.map((o) => (
                <li key={o.id}>{o.reason === 'active_subscription' ? t('deleteOrgSubscription', { name: o.name }) : t('deleteOwnedOrgWithOthers', { name: o.name })}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              {plan.blocked.some((o) => o.reason === 'other_members') ? (
                <Button asChild variant="secondary"><Link href={flatHref('/organization/members')} onClick={onClose}>{t('deleteGoMembers')}</Link></Button>
              ) : null}
              {plan.blocked.some((o) => o.reason === 'active_subscription') ? (
                <Button asChild variant="secondary"><Link href={flatHref('/settings?tab=billing')} onClick={onClose}>{t('deleteGoBilling')}</Link></Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {error ? (
          <Banner tone="failed"><span data-testid="delete-account-error">{error}</span></Banner>
        ) : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="quiet" onClick={onClose} disabled={deleting}>
            {tc('cancel')}
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={deleting || blocked} data-testid="delete-account-confirm">
            {deleting ? '...' : t('confirmDelete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
