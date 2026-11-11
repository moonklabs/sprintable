'use client';

// story 4891 (UI-8 · settings frame + four tabs) — the «계정 삭제» pane (the `danger` section): the danger card with the sentence about what deleting the account does and the one button that asks the page to open the confirmation
// (`DeleteAccountDialog`). Same words as the old card; the look is the one `OrgDangerSection` already has (a failed-toned title and border) — the page owns what the press opens.
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { SettingsSection } from './settings-section';

export function AccountDangerSection({ onOpenDelete }: { onOpenDelete: () => void }) {
  const t = useTranslations('settings');
  return (
    <SettingsSection
      title={<span className="text-ds-failed">{t('dangerZone')}</span>}
      description={t('dangerDescription')}
      className="border-ds-failed/40"
      id="account-danger"
    >
      <p className="text-ds-body text-ds-ink">{t('deleteAccountDesc')}</p>
      <div>
        <Button type="button" variant="danger" size="lg" onClick={onOpenDelete}>
          {t('deleteAccount')}
        </Button>
      </div>
    </SettingsSection>
  );
}
