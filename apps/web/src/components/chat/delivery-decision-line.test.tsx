// @vitest-environment jsdom
/** story 5032 (C2) — the sender's «→ @○○에게만 전달» line, drawn from the server's own delivery decision (never from the text). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DeliveryDecisionLine } from './delivery-decision-line';
import { normalizeToMessage, parseDeliveryDecision, sentMessageFromAnswer, type DeliveryDecision } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const NAMES: Record<string, string> = { a1: '개발', a2: '디자인', a3: '검수', a4: '기획', a5: '문서' };
const nameOf = (id: string) => NAMES[id];
const d = (delivered: string[], not: string[], humans: number): DeliveryDecision => ({ agents_delivered: delivered, agents_not_delivered: not, humans_delivered: humans });

async function render(decision: DeliveryDecision | undefined, isMine = true, locale: 'ko' | 'en' = 'ko', of: (id: string) => string | undefined = nameOf) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <DeliveryDecisionLine decision={decision} isMine={isMine} nameOf={of} />
      </NextIntlClientProvider>,
    );
  });
  return container.querySelector('[data-testid="delivery-decision-line"]');
}

describe('DeliveryDecisionLine (story 5032)', () => {
  it('⭐ some agents got it, some did not → «→ @개발에게만 전달» (the delivered ones, by name)', async () => {
    const el = await render(d(['a1'], ['a2'], 1));
    expect(el?.textContent).toBe('→ @개발에게만 전달');
    expect(el?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('two delivered → both named · more than three → the first three and «외 N»', async () => {
    expect((await render(d(['a1', 'a2'], ['a3'], 0)))?.textContent).toBe('→ @개발 · @디자인에게만 전달');
    expect((await render(d(['a1', 'a2', 'a3', 'a4'], ['a5'], 0)))?.textContent).toBe('→ @개발 · @디자인 · @검수 외 1에게만 전달');
  });

  it('⭐ no agent got it, people did → «→ 사람들에게만 전달 — 에이전트에게는 안 가요»; nobody got it → «→ 에이전트에게는 안 가요»', async () => {
    expect((await render(d([], ['a1', 'a2'], 2)))?.textContent).toBe('→ 사람들에게만 전달 — 에이전트에게는 안 가요');
    expect((await render(d([], ['a1'], 0)))?.textContent).toBe('→ 에이전트에게는 안 가요');
  });

  it('⭐ every agent got it, or the room has no agent → NO line (nothing to explain)', async () => {
    expect(await render(d(['a1', 'a2'], [], 1))).toBeNull();
    expect(await render(d([], [], 3))).toBeNull();
  });

  it('only the sender\'s own line · no decision (an older server · a failed pre-check) → NO line, never «to nobody»', async () => {
    expect(await render(d([], ['a1'], 1), false)).toBeNull();
    expect(await render(undefined)).toBeNull();
  });

  it('a delivered agent whose name is unknown is counted, not shown as «@undefined»', async () => {
    const el = await render(d(['zz'], ['a2'], 1), true, 'ko', () => undefined);
    expect(el?.textContent).toBe('→ 에이전트 1에게만 전달');
    expect(el?.textContent).not.toContain('undefined');
  });

  it('English: plural-safe words', async () => {
    expect((await render(d(['a1'], ['a2'], 1), true, 'en'))?.textContent).toBe('→ Delivered only to @개발');
    expect((await render(d([], ['a2'], 1), true, 'en'))?.textContent).toBe('→ Delivered to people only — agents did not get it');
  });
});

describe('the wire (story 5032)', () => {
  const wire = { agents_delivered: ['a1'], agents_not_delivered: ['a2'], humans_delivered: 1 };
  it('parseDeliveryDecision keeps a full valid shape and drops anything incomplete (absent stays absent)', () => {
    expect(parseDeliveryDecision(wire)).toEqual(wire);
    expect(parseDeliveryDecision(undefined)).toBeUndefined();
    expect(parseDeliveryDecision({ agents_delivered: ['a1'] })).toBeUndefined();
    expect(parseDeliveryDecision({ ...wire, humans_delivered: -1 })).toBeUndefined();
    expect(parseDeliveryDecision({ ...wire, agents_delivered: [1] })).toBeUndefined();
  });
  it('a later read of the sender\'s line and the send answer both carry it onto the message', () => {
    expect(normalizeToMessage({ id: 'm1', delivery_decision: wire }).delivery_decision).toEqual(wire);
    expect(normalizeToMessage({ id: 'm1' }).delivery_decision).toBeUndefined();
    const sent = sentMessageFromAnswer({ data: { id: 'm2', content: 'hi' }, delivery_decision: wire });
    expect(sent.delivery_decision).toEqual(wire); // reverted → the line only appears after a reload
  });
});
