'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

const THEMES = [
  { value: 'light', Icon: Sun },
  { value: 'dark', Icon: Moon },
  { value: 'system', Icon: Monitor },
] as const;

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  return (
    <div className={`flex items-center gap-1 ${className}`.trim()}>
      {THEMES.map(({ value, Icon }) => {
        const isActive = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={isActive}
            aria-label={value}
            className={`rounded-xl p-1.5 transition ${
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-[color:var(--operator-muted)] hover:bg-[color:var(--operator-surface-soft)] hover:text-[color:var(--operator-foreground)]'
            }`}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
