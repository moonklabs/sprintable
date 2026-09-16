'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Palette } from 'lucide-react';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

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
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground"><Palette className="size-4" />{t('themeSettingsTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('themeFollowSystemDesc')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground">
              {t('themeSelectLabel')}
            </label>
            <OperatorDropdownSelect
              value={theme || 'system'}
              onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
              options={[
                { value: 'light', label: t('themeLight') },
                { value: 'dark', label: t('themeDark') },
                { value: 'system', label: t('themeSystem') },
              ]}
            />
          </div>

          {theme === 'system' && (
            <p className="text-sm text-muted-foreground">
              {t('themeCurrentSystemLabel')} <span className="font-medium text-foreground">{currentTheme === 'dark' ? t('themeDark') : t('themeLight')}</span>
            </p>
          )}
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
