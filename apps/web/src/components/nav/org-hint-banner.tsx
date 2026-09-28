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

  // The notification's own path (without the hint), taken when the hint first appears. The shell may add its own query
  // (`?p=` …) before the person presses switch; the switch still lands where the notification pointed.
  const landing = useRef<string | null>(null);
  if (hint !== null && landing.current === null) landing.current = cleanUrl();

  useEffect(() => {
    // not an org of theirs, already the current org, malformed or empty → just drop the hint
    if (hint !== null && !offer) router.replace(cleanUrl());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanUrl reads the same searchParams/pathname
  }, [hint, offer]);

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
        router.replace(landing.current ?? cleanUrl());
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
      {/* AlertTitle · AlertDescription are <p>: only text inside them; the error and the buttons are their own blocks */}
      <AlertDescription>{t('orgHintBody', { org: target.orgName })}</AlertDescription>
      {failed ? <p role="alert" className="text-sm">{t('switcherSwitchOrgError')}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
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
