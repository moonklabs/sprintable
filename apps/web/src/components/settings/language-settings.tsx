'use client';

// story #4413(유나 자리 결정) — 폰(768 미만)에서 언어를 바꿀 길이 0이었다(언어 전환기가 사이드바에만 있고 폰 사이드바 문은 2683이 걷음).
// 설정 화면 «화면» 탭 · 테마 바로 아래에 같은 행 모양으로 둔다. 선택지는 늘 **자기 언어 이름**(한국어 · English) — 지금 언어와 무관하게
// 같은 글자라 못 읽는 언어로 바뀌어 있어도 찾는다. 바꾸는 동작은 사이드바 전환기와 같은 `applyLocale`(쿠키 + 새로고침).
// story 4891 (UI-8 · piece ③) — ds 부품(SettingsSection · Field · NativeSelect)으로: 같은 두 선택지 · 같은 `applyLocale`, 폰의 기본 선택기가 열린다.

import { useLocale, useTranslations } from 'next-intl';
import { applyLocale } from '@/components/locale-switcher';
import { Field } from '@/components/ds/field';
import { NativeSelect } from '@/components/ds/select';
import { SettingsSection } from './settings-section';

export function LanguageSettings() {
  const t = useTranslations('settings');
  const locale = useLocale();
  const current = locale.startsWith('en') ? 'en' : 'ko';

  return (
    <SettingsSection title={t('languageSettingsTitle')}>
      <Field label={t('languageSelectLabel')}>
        {(control) => (
          <NativeSelect {...control} className="pointer-coarse:[&_select]:h-11" value={current} onChange={(e) => { if (e.target.value !== current) applyLocale(e.target.value); }}>
            <option value="ko">{t('languageOptionKo')}</option>
            <option value="en">{t('languageOptionEn')}</option>
          </NativeSelect>
        )}
      </Field>
    </SettingsSection>
  );
}
