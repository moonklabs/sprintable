'use client';

import type { ColorToken } from '@/lib/parse-design-tokens';

function readVar(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function ColorSwatch({ token }: { token: ColorToken }) {
  const value = readVar(token.cssVar);
  return (
    <div className="flex items-center gap-3">
      <div
        className="size-8 shrink-0 rounded border border-border/60"
        style={{ background: `var(${token.cssVar})` }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{token.name}</p>
        <p suppressHydrationWarning className="truncate font-mono text-[10px] text-muted-foreground">
          {value || token.cssVar}
        </p>
      </div>
      <code className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {token.tailwind}
      </code>
    </div>
  );
}
