'use client';

import type { FontToken } from '@/lib/parse-design-tokens';
import { Card } from '@/components/ui/card';

export function FontPreview({ token }: { token: FontToken }) {
  return (
    // story #3785(유나·페드루 라이브 실측 확定) — 표본 컨테이너 형: 1층 규칙 그대로
    // Card(surface='solid'). 전시 대상이 글자(폰트 표본)라 카드 표면과 안 섞인다.
    <Card className="flex items-center gap-4 px-4 py-3">
      <div className="w-24 shrink-0">
        <p className="text-xs font-medium text-foreground">{token.name}</p>
        <code className="font-mono text-[10px] text-muted-foreground">{token.tailwind}</code>
      </div>
      <p className="flex-1 text-base text-foreground" style={{ fontFamily: `var(${token.cssVar})` }}>
        The quick brown fox jumps over the lazy dog
      </p>
    </Card>
  );
}
