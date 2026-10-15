// @vitest-environment jsdom
/** story #4430 — the «not delivered» line under the sender's own bubble (design: artifact 12b94be8). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { WithheldDeliveryLine } from './withheld-delivery-line';
import type { DeliveryWithheld } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render(withheld: DeliveryWithheld | undefined, isMine: boolean, locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <WithheldDeliveryLine withheld={withheld} isMine={isMine} />
      </NextIntlClientProvider>,
    );
  });
  return container.querySelector('[data-testid="withheld-delivery-line"]');
}

describe('WithheldDeliveryLine (#4430)', () => {
  it('1:1 — the ko 1:1 line, visible text, muted, keep-all, the icon hidden from screen readers', async () => {
    const line = await render({ withheld_count: 1, conversation_type: 'dm' }, true);
    expect(line?.textContent).toBe('전달되지 않았어요 — 받는 사람이 내 메시지를 받지 않도록 해 두었어요');
    expect(line?.className).toContain('text-xs');
    expect(line?.className).toContain('text-muted-foreground');
    expect(line?.className).toContain('break-keep');
    expect(line?.className).not.toMatch(/red|destructive/);
    expect(line?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(line?.querySelector('button')).toBeNull();
  });

  it('group — a count, never who', async () => {
    const line = await render({ withheld_count: 2, conversation_type: 'group' }, true);
    expect(line?.textContent).toBe('2명에게는 전달되지 않았어요 — 내 메시지를 받지 않도록 해 둔 사람이 있어요');
  });

  it('unknown room kind — the count line (true for any count)', async () => {
    const line = await render({ withheld_count: 1 }, true);
    expect(line?.textContent).toBe('1명에게는 전달되지 않았어요 — 내 메시지를 받지 않도록 해 둔 사람이 있어요');
  });

  it('en — 1:1 and the plural group line', async () => {
    expect((await render({ withheld_count: 1, conversation_type: 'dm' }, true, 'en'))?.textContent)
      .toBe('Not delivered — the recipient has chosen not to receive your messages');
    expect((await render({ withheld_count: 1, conversation_type: 'group' }, true, 'en'))?.textContent)
      .toBe("Not delivered to 1 person — they've chosen not to receive your messages");
    expect((await render({ withheld_count: 3, conversation_type: 'group' }, true, 'en'))?.textContent)
      .toBe("Not delivered to 3 people — they've chosen not to receive your messages");
  });

  it('nothing on someone else\'s message, and nothing when nothing was withheld', async () => {
    expect(await render({ withheld_count: 1, conversation_type: 'dm' }, false)).toBeNull();
    expect(await render(undefined, true)).toBeNull();
    expect(container.innerHTML).toBe('');
  });
});
