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

/**
 * story #4583 AC6 (live run 13 · 07:07Z): pressing the link is an in-app (client) navigation, and there the card's arrival focus
 * did not hold — the switch ended unfocused (activeElement = body), while opening the same address fresh focused it. Next's own
 * scroll handler runs on a later commit after a client navigation and moves the focus (16.x: it blurs the active element · the
 * older handler focuses the hash target instead). So: the link leaves a one-time «arriving» mark (the card then knows even if the
 * address has no `#` yet when it mounts), and the card holds its focus for a moment against a move it did not make.
 */
const ARRIVAL_MS = 5000;
let arrivalAt = 0;

export function markArrival(): void {
  arrivalAt = Date.now();
}

/** the link's click: only a plain primary click navigates here — a new tab / window (modifier · middle button) leaves no mark (Yuna 4974) */
function markPlainClick(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number; defaultPrevented: boolean }): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || e.defaultPrevented) return;
  markArrival();
}

/** true once, within ARRIVAL_MS of a link press — and clears it */
export function takeArrival(): boolean {
  const fresh = arrivalAt > 0 && Date.now() - arrivalAt < ARRIVAL_MS;
  arrivalAt = 0;
  return fresh;
}

export const ARRIVED_ATTR = 'data-arrived';

/**
 * Focus `target`, mark it `data-arrived` (its ring is drawn from that mark — `:focus-visible` is the browser's guess and is false
 * after a pointer press, which is how the link is usually pressed · Yuna 4974), and for `holdMs` put the focus back if it falls
 * to the page (body) or onto `card` itself without the person acting.
 * The mark comes off at the person's first key or pointer press (from then on the browser's own ring rules), or when the focus
 * leaves after the hold — never only because the hold's time ran out (the ring vanishing while the focus stays would be a change
 * on screen). Returns the cleanup.
 */
export function holdArrivalFocus(target: HTMLElement, card: HTMLElement | null, holdMs = 1500): () => void {
  target.setAttribute(ARRIVED_ATTR, '');
  target.focus();
  let holding = true;
  let ended = false;
  const unmark = () => target.removeAttribute(ARRIVED_ATTR);
  const byPerson = () => { unmark(); end(); };
  const onOut = () => {
    // the new focus is known only after the event — look once it has landed
    setTimeout(() => {
      if (ended) return;
      const now = document.activeElement;
      const lost = now === null || now === document.body || (card !== null && now === card && card !== target);
      if (holding && lost) { target.focus(); return; }
      if (now !== target) { unmark(); end(); } // the focus went elsewhere after the hold
    }, 0);
  };
  const end = () => {
    ended = true;
    target.removeEventListener('focusout', onOut);
    document.removeEventListener('keydown', byPerson, true);
    document.removeEventListener('pointerdown', byPerson, true);
    clearTimeout(timer);
  };
  target.addEventListener('focusout', onOut);
  document.addEventListener('keydown', byPerson, true);
  document.addEventListener('pointerdown', byPerson, true);
  const timer = setTimeout(() => { holding = false; }, holdMs);
  return () => { unmark(); end(); };
}

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
    return <Button asChild><Link href={href} onClick={markPlainClick} data-testid="remote-off-link">{t('goTo')}</Link></Button>;
  }
  return <Link href={href} onClick={markPlainClick} className="text-sm underline" data-testid="remote-off-link">{t('goTo')}</Link>;
}
