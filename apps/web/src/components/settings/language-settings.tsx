'use client';

// story #4413(유나 자리 결정) — 폰(768 미만)에서 언어를 바꿀 길이 0이었다(언어 전환기가 사이드바에만 있고 폰 사이드바 문은 2683이 걷음).
// 설정 화면 «화면» 탭 · 테마 바로 아래에 같은 행 모양으로 둔다. 선택지는 늘 **자기 언어 이름**(한국어 · English) — 지금 언어와 무관하게
// 같은 글자라 못 읽는 언어로 바뀌어 있어도 찾는다. 바꾸는 동작은 사이드바 전환기와 같은 `applyLocale`(쿠키 + 새로고침).

import { useLocale, useTranslations } from 'next-intl';
import { Globe } from 'lucide-react';
import { applyLocale } from '@/components/locale-switcher';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

export function LanguageSettings() {
  const t = useTranslations('settings');
  const locale = useLocale();
  const current = locale.startsWith('en') ? 'en' : 'ko';

  return (
    <SectionCard>
      <SectionCardHeader>
        <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground"><Globe className="size-4" />{t('languageSettingsTitle')}</h2>
      </SectionCardHeader>
      <SectionCardBody>
        <label className="block text-sm font-medium mb-2 text-foreground">{t('languageSelectLabel')}</label>
        <OperatorDropdownSelect
          value={current}
          onValueChange={(v) => { if (v !== current) applyLocale(v); }}
          options={[
            { value: 'ko', label: t('languageOptionKo') },
            { value: 'en', label: t('languageOptionEn') },
          ]}
        />
      </SectionCardBody>
    </SectionCard>
  );
}
