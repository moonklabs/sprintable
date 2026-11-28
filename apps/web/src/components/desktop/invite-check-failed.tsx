'use client';

// story 4711 AC4 — the setup pages no longer send a person whose invites could not be read to a «조직 만들기» screen (that screen is gone: the app's setup
// makes the organization itself, from the folder). Not knowing is not «no invites»: the page says so in Yuna's 4715 words (`onboarding.inviteCheckFailed`
// · `inviteCheckAgain`, the same ones the web first screen shows) and reads again on [다시 확인] — nothing is made until the answer is known.
// story 5048 ⑤ (④): the ds ErrorState (was a ui Card + outline Button).
import { useTranslations } from 'next-intl';
import { ErrorState } from '@/components/ds/error-state';

export function InviteCheckFailedCard({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('onboarding');
  return <ErrorState data-testid="setup-invite-check-failed" title={t('inviteCheckFailed')} retryLabel={t('inviteCheckAgain')} onRetry={onRetry} />;
}
