'use client';

import type { FontToken } from '@/lib/parse-design-tokens';

export function FontPreview({ token }: { token: FontToken }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border/60 px-4 py-3">
      <div className="w-24 shrink-0">
        <p className="text-xs font-medium text-foreground">{token.name}</p>
        <code className="font-mono text-[10px] text-muted-foreground">{token.tailwind}</code>
      </div>
      <p className="flex-1 text-base text-foreground" style={{ fontFamily: `var(${token.cssVar})` }}>
        The quick brown fox jumps over the lazy dog
      </p>
    </div>
  );
}
