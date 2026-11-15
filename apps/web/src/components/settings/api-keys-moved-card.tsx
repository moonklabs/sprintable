'use client';

// story 4891 (UI-8 · settings frame + four tabs) — the «API 키» pane. The agent keys moved to the agent management page, so this pane is one card with the way there: the same sentence, the same destination (`/organization/workforce`), now on the ds parts.
// (The pane had no title of its own before; it now carries the section's name — the same words the list row says.)
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { useFlatHref } from '@/hooks/use-flat-href';
import { SettingsSection } from './settings-section';

export function ApiKeysMovedCard() {
  const t = useTranslations('settings');
  const router = useRouter();
  const flatHref = useFlatHref(); // a flat destination carries the project (story #4226 ratchet)
  return (
    <SettingsSection title={t('tabApiKeys')} id="api-keys">
      <p className="text-ds-body text-ds-ink-2">{t.rich('agentApiKeyMoved', { b: (chunks) => <strong>{chunks}</strong> })}</p>
      <div>
        <Button type="button" size="lg" onClick={() => router.push(flatHref('/organization/workforce'))}>
          {t('agentManagementCta')}
        </Button>
      </div>
    </SettingsSection>
  );
}
