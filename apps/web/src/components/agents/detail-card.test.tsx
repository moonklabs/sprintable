// @vitest-environment jsdom
// story 4912 (C1) — the agent detail's sub-tab card on ONE layer (ds Card = LAYER.panel) with a header line and a padded body.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DetailCard } from './detail-card';
import { LAYER } from '@/components/ds/layers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
const render = (n: React.ReactNode) => act(async () => { root.render(n); });

describe('DetailCard', () => {
  it('⭐면은 ds Card의 내용 칸 층(LAYER.panel) 하나 — 옛 SectionCard(bg-card)가 아니다', async () => {
    await render(<DetailCard data-testid="c" title="제목">본문</DetailCard>);
    const card = container.querySelector('[data-testid="c"]') as HTMLElement;
    expect(card.getAttribute('data-slot')).toBe('ds-card');
    expect(card.className).toContain(LAYER.panel);
    expect(card.className).not.toMatch(/(?<![\w-])bg-card(?![\w-])/);
  });

  it('머리 줄: 제목(h2) · 상태 칩 · 설명 · 오른쪽 한 컨트롤 — 본문은 따로 패딩 칸', async () => {
    await render(<DetailCard title="알림 채널" chips={<span data-testid="st">상태</span>} description="설명 글" action={<button type="button" data-testid="ac">저장</button>}><p data-testid="body">내용</p></DetailCard>);
    const head = container.querySelector('[data-slot="detail-card-header"]')!;
    expect(head.querySelector('h2')?.textContent).toBe('알림 채널');
    expect(head.querySelector('[data-testid="st"]')).not.toBeNull();
    expect(head.textContent).toContain('설명 글');
    expect(head.querySelector('[data-testid="ac"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="detail-card-body"] [data-testid="body"]')).not.toBeNull();
  });

  it('제목이 없으면 머리 줄 없이 본문만(한 줄 안내 카드) · 본문이 없으면 본문 칸이 안 그려진다', async () => {
    await render(<DetailCard data-testid="notice"><p>안내</p></DetailCard>);
    expect(container.querySelector('[data-testid="notice"] [data-slot="detail-card-header"]')).toBeNull();
    expect(container.querySelector('[data-testid="notice"] [data-slot="detail-card-body"]')).not.toBeNull();
    await render(<DetailCard data-testid="head-only" title="머리만" />);
    expect(container.querySelector('[data-testid="head-only"] [data-slot="detail-card-body"]')).toBeNull();
  });
});
