'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

export function ThemeSettings() {
  const { theme, setTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const currentTheme = theme === 'system' ? systemTheme : theme;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">🎨 테마 설정</h2>
          <p className="text-sm text-[color:var(--operator-muted)]">라이트 모드, 다크 모드 또는 시스템 설정을 따를 수 있습니다.</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-[color:var(--operator-foreground)]">
              테마 선택
            </label>
            <OperatorDropdownSelect
              value={theme || 'system'}
              onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
              options={[
                { value: 'light', label: '라이트 모드' },
                { value: 'dark', label: '다크 모드' },
                { value: 'system', label: '시스템 설정' },
              ]}
            />
          </div>

          {theme === 'system' && (
            <p className="text-sm text-[color:var(--operator-muted)]">
              현재 시스템 설정: <span className="font-medium text-[color:var(--operator-foreground)]">{currentTheme === 'dark' ? '다크 모드' : '라이트 모드'}</span>
            </p>
          )}
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
