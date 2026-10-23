'use client';

// story 4711 AC4 — the setup pages no longer send a person whose invites could not be read to a «조직 만들기» screen (that screen is gone: the app's setup
// makes the organization itself, from the folder). Not knowing is not «no invites»: the page says so in Yuna's 4715 words (`onboarding.inviteCheckFailed`
// · `inviteCheckAgain`, the same ones the web first screen shows) and reads again on [다시 확인] — nothing is made until the answer is known.
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export function InviteCheckFailedCard({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('onboarding');
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="setup-invite-check-failed">
      <p role="alert" className="text-sm">{t('inviteCheckFailed')}</p>
      <div><Button variant="outline" onClick={onRetry}>{t('inviteCheckAgain')}</Button></div>
    </Card>
  );
}
