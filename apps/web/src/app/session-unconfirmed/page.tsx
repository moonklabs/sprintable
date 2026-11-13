import { AccountContextFailure } from '@/components/auth/account-context-failure';

/**
 * story 4915 (PR 2) — the page the proxy rewrites an unconfirmed page load to (lib/auth/session-unconfirmed): the existing «다시 시도» screen and nothing else — no session, no data, no children.
 * The retry button re-requests the address in the bar; the proxy then tries the refresh again.
 */
export default function SessionUnconfirmedPage() {
  return <AccountContextFailure />;
}
