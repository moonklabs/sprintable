// 4913 — «이 컴퓨터와 폰» 화면(/desktop)의 카드는 «화면 층 규칙»의 내용 칸(LAYER.panel)을 쓴다. 옛 ui/card(bg-card)면은 다크에서 바탕과의 밝기차가 0.024(문턱 0.03 밑)였다 —
// 다시 옛 Card로 돌아가면 아래가 빨갛게 된다. 값(라이트 · 다크 밝기차)은 styles/layer-rule.test.ts가 토큰으로 지킨다 — 여기서는 «이 화면이 그 층 토큰을 쓴다»만 소스로 고정한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardVariants } from '@/components/ds/card';
import { LAYER } from '@/components/ds/layers';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

// /desktop 본 화면(page.tsx)이 그리는 카드 부품 전부 — 새 카드 부품이 더해지면 여기에도 더한다(목록은 page.tsx 소스에서 읽어 어긋나면 빨강).
const PAGE_CARDS = [
  'desktop-open-app-card.tsx',
  'desktop-download-card.tsx',
  'phone-relay-local-notice.tsx',
  'desktop-remote-control-card.tsx',
  'desktop-remote-devices.tsx',
  'phone-session-management.tsx',
  'desktop-devices.tsx',
] as const;

describe('/desktop 화면 카드는 내용 칸 층(LAYER.panel)이다 (4913)', () => {
  it('⭐ds Card의 면은 LAYER.panel 그대로다(층 표와 한 토큰)', () => {
    expect(cardVariants()).toContain(LAYER.panel);
  });

  it('⭐화면이 그리는 카드 부품은 전부 ds Card — 옛 ui/card(bg-card)로 돌아가면 빨강', () => {
    for (const f of PAGE_CARDS) {
      const src = read(f);
      expect(src, `${f} imports the ds Card`).toContain("import { Card } from '@/components/ds/card';");
      expect(src, `${f} must not use the old ui/card`).not.toContain("@/components/ui/card");
    }
  });

  it('⭐page.tsx가 그리는 부품이 위 목록과 같다 — 새 카드 부품이 층 시험 밖에 서지 못한다', () => {
    const page = readFileSync(join(__dirname, '../../app/(authenticated)/desktop/page.tsx'), 'utf8');
    const used = [...page.matchAll(/from '@\/components\/desktop\/([a-z-]+)'/g)].map((m) => `${m[1]}.tsx`);
    // DesktopPageHead는 카드가 아니라 머리다
    const cards = used.filter((f) => f !== 'desktop-page-head.tsx').sort();
    expect(cards).toEqual([...PAGE_CARDS].sort());
  });
});
