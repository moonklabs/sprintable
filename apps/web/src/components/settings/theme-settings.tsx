'use client';

// story 4891 (UI-8 · settings › 화면 · piece ③) — the theme card on the ds parts (SettingsSection · Field · NativeSelect): the same three choices, the same `setTheme`; the phone's own picker opens
// instead of the old dropdown menu. The «following the system» line stays under the field.
import { useTheme } from 'next-themes';
import { useEffect, useState, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/ds/field';
import { NativeSelect } from '@/components/ds/select';
import { SettingsSection } from './settings-section';

export function ThemeSettings() {
  const t = useTranslations('settings');
  const { theme, setTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    startTransition(() => setMounted(true));
  }, []);

  if (!mounted) {
    return null;
  }

  const currentTheme = theme === 'system' ? systemTheme : theme;

  return (
    <SettingsSection title={t('themeSettingsTitle')} description={t('themeFollowSystemDesc')}>
      <Field label={t('themeSelectLabel')}>
        {(control) => (
          <NativeSelect {...control} value={theme || 'system'} onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}>
            <option value="light">{t('themeLight')}</option>
            <option value="dark">{t('themeDark')}</option>
            <option value="system">{t('themeSystem')}</option>
          </NativeSelect>
        )}
      </Field>
      {theme === 'system' && (
        <p className="text-ds-body text-ds-ink-3">
          {t('themeCurrentSystemLabel')} <span className="font-medium text-ds-ink">{currentTheme === 'dark' ? t('themeDark') : t('themeLight')}</span>
        </p>
      )}
    </SettingsSection>
  );
}
