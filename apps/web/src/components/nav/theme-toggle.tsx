'use client';

import { useEffect, useState, startTransition } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';

const THEMES = [
  { value: 'light', Icon: Sun, labelKey: 'themeLight' },
  { value: 'dark', Icon: Moon, labelKey: 'themeDark' },
  { value: 'system', Icon: Monitor, labelKey: 'themeSystem' },
] as const;

export function ThemeToggle({ className = '' }: { className?: string }) {
  const t = useTranslations('settings');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  return (
    <div className={`flex items-center gap-1 ${className}`.trim()}>
      {THEMES.map(({ value, Icon, labelKey }) => {
        const isActive = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={isActive}
            aria-label={t(labelKey)}
            className={`rounded-xl p-1.5 transition ${
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
