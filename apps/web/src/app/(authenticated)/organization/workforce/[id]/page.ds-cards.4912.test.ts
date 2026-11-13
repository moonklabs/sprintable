// story 4912 (C1) — the detail page's own sub-tab cards stand on the ds Card (DetailCard), not on the old ui/section-card · ui/badge, and their status words are ds Chips.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const code = readFileSync(join(__dirname, 'page.tsx'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('에이전트 상세 하위 탭 카드 — ds 한 층(story 4912 · C1)', () => {
  it('⭐옛 ui/section-card · ui/badge를 import하지 않고 <SectionCard · <Badge를 그리지 않는다 — 되돌리면 RED', () => {
    expect(code).not.toMatch(/from '@\/components\/ui\/section-card'/);
    expect(code).not.toMatch(/from '@\/components\/ui\/badge'/);
    expect(code).not.toContain('<SectionCard');
    expect(code).not.toContain('<Badge');
  });

  it('⭐다섯 카드(런타임 타입 · SSE · 시스템 발행 안내 · 알림 채널 · 수신 계약 요약)가 DetailCard로 선다', () => {
    expect(code).toContain("from '@/components/agents/detail-card'");
    for (const id of ['agent-detail-card-runtime', 'agent-detail-card-sse', 'agent-detail-card-system-notice', 'agent-detail-card-webhook', 'agent-detail-card-notification-summary']) {
      expect(code, id).toContain(`data-testid="${id}"`);
    }
    expect((code.match(/<DetailCard/g) ?? []).length).toBe(5);
  });

  it('이 카드들 안에 옛 글자 토큰(text-muted-foreground · text-base · text-warning-strong · text-success)이 없다 — ds 글자 척도만', () => {
    // the header (avatar · name) and the sections outside the five cards are other pieces; the five cards are the ranges between <DetailCard … </DetailCard>
    const cards = [...code.matchAll(/<DetailCard[\s\S]*?<\/DetailCard>/g)].map((m) => m[0]);
    expect(cards.length).toBe(5);
    for (const c of cards) expect(c).not.toMatch(/text-(muted-foreground|base|warning-strong|success|foreground)\b/);
  });
});
