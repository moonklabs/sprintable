// story 5048 ⑤-⑧ — «핵심 화면(채널 대화 · 홈 · 설정) 안 자기 스켈레톤»이 옛 ui/skeleton(shimmer)이 아니라 ds Skeleton이다. 막대 수 · 높이 · 폭은 옛 값 그대로(모양 그대로 — ⑦과 같은 꼴).
// 화면이 무거워(채팅 · 홈 harness) 그대로 그리는 대신 «가져오는 곳 + 막대 클래스»를 소스에서 고정하고, 혼자 그려지는 `ConnectRulesV3SectionSkeleton`만 그려서 본다.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import koMessages from '../../../messages/ko.json';
import { ConnectRulesV3SectionSkeleton } from '@/components/connect-rules-v3/connect-rules-v3-section-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const SRC = join(__dirname, '..', '..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');
const count = (s: string, needle: string) => s.split(needle).length - 1;

// 파일 → [막대 클래스 줄, 개수] (옛 ui/skeleton 때 값 그대로)
const BARS: Record<string, Array<[string, number]>> = {
  'components/chat-v3/chat-v3-screen.tsx': [['<Skeleton className="h-12 w-full" />', 4]],
  'components/chat-v3/chat-v3-messages.tsx': [['<Skeleton className="h-10 w-2/3" />', 1], ['<Skeleton className="ml-auto h-10 w-2/3" />', 1], ['<Skeleton className="h-10 w-1/2" />', 1]],
  'components/chat-v3/chat-v3-context-panel.tsx': [['<Skeleton className="h-8 w-full" />', 4]],
  'components/chat/asset-picker-popover.tsx': [['<Skeleton className="size-[30px] shrink-0" />', 1], ['<Skeleton className="h-3 w-2/3" />', 1], ['<Skeleton className="h-2.5 w-2/5" />', 1]],
  'components/chat/asset-embed-card.tsx': [['<Skeleton className="size-[38px] shrink-0" />', 1], ['<Skeleton className="h-3 w-3/4" />', 1], ['<Skeleton className="h-2.5 w-1/3" />', 1]],
  'components/chat/approval-request-card.tsx': [['<Skeleton as="span" className="h-3 w-20 align-middle" aria-hidden />', 1], ['<Skeleton as="span" className="h-3 w-28" aria-hidden />', 1]],
  'components/today-v3/today-v3-screen.tsx': [['<Skeleton className="h-24 w-full" />', 2]],
  'components/connect-rules-v3/connect-rules-v3-screen.tsx': [['<Skeleton className="h-24" />', 2]],
  'components/connect-rules-v3/connect-rules-v3-section-state.tsx': [['<Skeleton key={i} className="h-14" />', 1]],
  'components/connect-rules-v3/connect-rules-v3-agents.tsx': [['<Skeleton className="h-4 w-40" />', 1]],
};

describe('핵심 화면 안 스켈레톤 — ds Skeleton(옛 ui/skeleton 0)', () => {
  it.each(Object.keys(BARS))('⭐%s: ds Skeleton을 가져오고 · ui/skeleton은 안 가져온다', (f) => {
    const s = read(f);
    expect(s).toContain("import { Skeleton } from '@/components/ds/skeleton';");
    expect(s).not.toMatch(/components\/ui\/skeleton/);
  });

  it.each(Object.entries(BARS))('⭐%s: 막대 높이 · 폭이 옛 값 그대로(되돌리거나 바꾸면 RED)', (f, bars) => {
    const s = read(f);
    for (const [line, n] of bars) expect(count(s, line), `${f}: ${line}`).toBe(n);
    expect(s).not.toMatch(/<Skeleton[^>]*variant="text"/); // ds text는 자기 패딩 상자라 막대가 달라진다 — 기본 rect + 명시 높이
    expect(s).not.toMatch(/<Skeleton[^>]*rounded-sm/); // ui용 모서리 덮어쓰기는 버렸다(ds 조작 모서리)
  });
});

describe('ConnectRulesV3SectionSkeleton — 혼자 그려 본다', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

  it('줄 수만큼 ds 막대(h-14) · 묶음은 장식(aria-hidden) · 옛 ui 막대 0', async () => {
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ConnectRulesV3SectionSkeleton rows={4} /></NextIntlClientProvider>); });
    const wrap = container.querySelector('[data-testid="connect-rules-v3-skeleton"]') as HTMLElement;
    expect(wrap.getAttribute('aria-hidden')).toBe('true');
    const bars = wrap.querySelectorAll('[data-slot="ds-skeleton"]');
    expect(bars).toHaveLength(4);
    for (const b of Array.from(bars)) expect(b.className).toContain('h-14');
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });
});
