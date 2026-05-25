'use client';

import type { RadiusToken } from '@/lib/parse-design-tokens';

function readVar(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function RadiusSwatch({ token }: { token: RadiusToken }) {
  const value = readVar(token.cssVar);
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="size-14 border-2 border-brand bg-brand/15"
        style={{ borderRadius: `var(${token.cssVar})` }}
      />
      <div className="text-center">
        <p className="text-xs font-medium text-foreground">{token.name}</p>
        <p suppressHydrationWarning className="font-mono text-[10px] text-muted-foreground">
          {value || '—'}
        </p>
      </div>
    </div>
  );
}
