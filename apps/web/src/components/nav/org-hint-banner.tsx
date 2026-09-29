'use client';

// story #4397 — a push notification opens its path with `org_id=<uuid>` (the notification's org). When that org is one of the
// person's orgs but not the one this tab is in, this card says so and offers the switch; the switch happens only when the
// person presses it, through the same POST /api/switch-org as the org switcher (a page GET never switches — switching revokes
// the person's refresh tokens on every device, story #3649). A hint for an org they are not in, for the current org, or a
// malformed one is removed from the address quietly.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';

export const ORG_HINT_PARAM = 'org_id';

export function OrgHintBanner() {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { orgId, orgMemberships } = useDashboardContext();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const hint = searchParams.get(ORG_HINT_PARAM); // null = no hint; '' (an empty `?org_id=`) is a hint to drop
  const target = hint ? orgMemberships.find((o) => o.orgId === hint) : undefined;
  const offer = !!target && target.orgId !== orgId;

  const cleanUrl = () => {
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete(ORG_HINT_PARAM);
    const query = rest.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  // The notification's own path (without the hint), taken when this notification first appears. The shell may add its
  // project (`?p=`, the only query it writes) before the person presses switch; the switch still lands where the
  // notification pointed. The shell stays mounted, so it is kept per notification — the hint plus its address apart from
  // `p` — and no hint clears it: the next notification (another org, or the same org elsewhere) takes its own path.
  const landing = useRef<{ key: string; path: string } | null>(null);
  if (hint === null) {
    landing.current = null;
  } else {
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete('p');
    const key = `${pathname}?${rest.toString()}`;
    if (landing.current?.key !== key) landing.current = { key, path: cleanUrl() };
  }

  // Keyed on the whole address, not only the hint: on a flat path the shell's `?p=` normalization replaces the address in the
  // same commit, from the search params it rendered with (the hint still in them), and that later replace wins (#4397 dev round:
  // /inbox?tab=gates&org_id=… kept org_id for a non-member, empty and current org). When that address lands, this runs again and
  // drops the hint from it (it already has `p`); the shell then has nothing to fix — both settle on the same address.
  const query = searchParams.toString();
  useEffect(() => {
    // not an org of theirs, already the current org, malformed or empty → just drop the hint
    if (hint !== null && !offer) router.replace(cleanUrl());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanUrl reads the same searchParams/pathname
  }, [hint, offer, query, pathname]);

  if (!offer || !target) return null;

  const switchNow = async () => {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetchWithAuth('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: target.orgId }),
      });
      const json = (await res.json().catch(() => null)) as { data?: { ok?: boolean } } | null;
      if (res.ok && json?.data?.ok) {
        // same as the org switcher: the previous org's tab project would be sent as X-Project-Id to the new org
        window.sessionStorage.removeItem(TAB_PROJECT_STORAGE_KEY);
        // land on the notification's own path (Yuna: «전환하면 이어서 열려요» holds only if the switch continues there)
        router.replace(landing.current?.path ?? cleanUrl());
        router.refresh();
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <Alert data-testid="org-hint-banner">
      <AlertTitle>{t('orgHintTitle')}</AlertTitle>
      {/* AlertTitle · AlertDescription are <p>: only text inside them; the error and the buttons are their own blocks, placed in
          the Alert grid's text column (col-start-2) like the title and description — column 1 is the icon slot */}
      <AlertDescription>{t('orgHintBody', { org: target.orgName })}</AlertDescription>
      {failed ? <p role="alert" className="col-start-2 text-sm">{t('switcherSwitchOrgError')}</p> : null}
      <div className="col-start-2 mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => void switchNow()}>
          {t('switcherSwitchToOrg')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => router.replace(cleanUrl())}>
          {tCommon('close')}
        </Button>
      </div>
    </Alert>
  );
}
