'use client';

/**
 * story #4583 — «원격 제어» off, said the same way everywhere (Yuna `4583/copy.md`): an owner gets a way to the switch, everyone else
 * the owner's name. Every place reads the one org value (`useOrgRemoteControl`) and shows nothing while it is on or not known.
 * The link only moves to the card (`/desktop#remote-control`); turning it on stays one press on the card itself.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useOrgRemoteControl } from '@/lib/org-remote-control';

export const REMOTE_CONTROL_ANCHOR = 'remote-control';

export interface RemoteOff {
  /** an owner (`can_change`): the link · anyone else: the names */
  owner: boolean;
  /** the values for the `{owners}` / `{hasOwners}` placeholders of every «not owner» line */
  names: { owners: string; hasOwners: 'yes' | 'no' };
  connectedComputers: number;
}

/** Yuna's name form: 1 «A» · 2 «A · B» · 3+ «A 외 n명» — always inside «조직 소유자(…)», so no josa depends on the name. */
export function formatOwners(names: readonly string[], more: (first: string, n: number) => string): string {
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(' · ');
  return more(names[0], names.length - 1);
}

/** The org's remote control when it is OFF (null: on · not known · not a person of the org). */
export function useRemoteOff(): RemoteOff | null {
  const { orgId } = useDashboardContext();
  const [state] = useOrgRemoteControl(orgId);
  const t = useTranslations('remoteControlOff');
  if (!state || state.enabled) return null;
  const owners = formatOwners(state.owner_names ?? [], (first, n) => t('ownersMore', { first, n }));
  return {
    owner: state.can_change,
    names: { owners, hasOwners: owners ? 'yes' : 'no' },
    connectedComputers: state.connected_computers ?? 0,
  };
}

/** «원격 제어 켜러 가기» — its own row under the line (never inline, so nothing wraps around it at phone width). */
export function RemoteControlLink({ variant = 'link' }: { variant?: 'link' | 'button' }) {
  const t = useTranslations('remoteControlOff');
  const flat = useFlatHref();
  const href = `${flat('/desktop')}#${REMOTE_CONTROL_ANCHOR}`;
  if (variant === 'button') {
    return <Button asChild><Link href={href} data-testid="remote-off-link">{t('goTo')}</Link></Button>;
  }
  return <Link href={href} className="text-sm underline" data-testid="remote-off-link">{t('goTo')}</Link>;
}
