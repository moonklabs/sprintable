'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState, startTransition } from 'react';
import { Palette } from 'lucide-react';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

export function ThemeSettings() {
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
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground"><Palette className="size-4" />테마 설정</h2>
          <p className="text-sm text-muted-foreground">라이트 모드, 다크 모드 또는 시스템 설정을 따를 수 있습니다.</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground">
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
            <p className="text-sm text-muted-foreground">
              현재 시스템 설정: <span className="font-medium text-foreground">{currentTheme === 'dark' ? '다크 모드' : '라이트 모드'}</span>
            </p>
          )}
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
