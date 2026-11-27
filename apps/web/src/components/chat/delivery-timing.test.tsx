// @vitest-environment jsdom
//
// story 5046 (C13) — WHEN a working agent gets a message: the choice above the input and the line under the sender's bubble.
// Red when: «지금» stops being the pressed default · the one-line «cannot interrupt» is missing (or drawn when «끝나고 이어서» is on) · the line under the bubble is drawn for someone else's message, for an old message,
// or invents a record · the wire parsers accept anything but the exact words · the message from the wire loses (or invents) the two fields.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DeliveryChoice, DeliveryTimingLine } from './delivery-timing';
import { normalizeToMessage, parseDeliveryLog, parseDeliveryMode } from '@/hooks/use-chat-sse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });
const draw = async (node: React.ReactNode) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); }); };
const btn = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const nameOf = (id: string) => ({ [A1]: '미르코', [A2]: '카디르' })[id];

describe('the choice', () => {
  it('«지금 끼어들기» is the pressed one by default; pressing «끝나고 이어서» says so and calls back', async () => {
    const onChange = vi.fn();
    await draw(<DeliveryChoice value="now" onChange={onChange} cannotInterject={[]} />);
    expect(btn('지금 끼어들기').getAttribute('aria-pressed')).toBe('true'); expect(btn('끝나고 이어서').getAttribute('aria-pressed')).toBe('false');
    await act(async () => { btn('끝나고 이어서').click(); });
    expect(onChange).toHaveBeenCalledWith('after_turn');
  });
  it('a runtime that cannot be interrupted says so in ONE line while «지금» is on — and not once «끝나고 이어서» is chosen', async () => {
    await draw(<DeliveryChoice value="now" onChange={() => {}} cannotInterject={['미르코', '카디르']} />);
    const note = container.querySelector('[data-testid="delivery-choice-note"]')!;
    expect(note.textContent).toBe('지금 끼어들 수 없는 에이전트: 미르코 · 카디르 — 끝난 뒤 전해요');
    await draw(<DeliveryChoice value="after_turn" onChange={() => {}} cannotInterject={['미르코']} />);
    expect(container.querySelector('[data-testid="delivery-choice-note"]')).toBeNull();
    await draw(<DeliveryChoice value="now" onChange={() => {}} cannotInterject={[]} />);
    expect(container.querySelector('[data-testid="delivery-choice-note"]')).toBeNull();
  });
});

describe('the line under the sender\'s bubble', () => {
  it('nothing for someone else\'s message, nor for a message sent the old way with nothing reported', async () => {
    await draw(<DeliveryTimingLine mode="after_turn" log={{ [A1]: { via: 'turn', at: '2026-11-26T12:00:00+00:00' } }} isMine={false} nameOf={nameOf} />);
    expect(container.querySelector('[data-testid="delivery-timing-line"]')).toBeNull();
    await draw(<DeliveryTimingLine mode={undefined} log={undefined} isMine nameOf={nameOf} />);
    expect(container.querySelector('[data-testid="delivery-timing-line"]')).toBeNull();
  });
  it('«끝나고 이어서» with no record yet says it is waiting', async () => {
    await draw(<DeliveryTimingLine mode="after_turn" log={undefined} isMine nameOf={nameOf} />);
    expect(container.textContent).toBe('끝나고 이어서 보내요 — 턴이 끝나면 들어가요');
  });
  it('a record names HOW it went in, per agent: into the running turn · after the turn ended', async () => {
    await draw(<DeliveryTimingLine mode="after_turn" log={{ [A1]: { via: 'turn', at: 'x' }, [A2]: { via: 'next_turn', at: 'y' } }} isMine nameOf={nameOf} />);
    expect(container.textContent).toContain('미르코 · 하던 턴에 바로 들어갔어요'); expect(container.textContent).toContain('카디르 · 턴이 끝난 뒤 들어갔어요');
  });
  it('a record shows even for a message sent «지금» (the old way): the server\'s word on how it went in', async () => {
    await draw(<DeliveryTimingLine mode={undefined} log={{ [A1]: { via: 'turn', at: 'x' } }} isMine nameOf={nameOf} />);
    expect(container.textContent).toBe('미르코 · 하던 턴에 바로 들어갔어요');
  });
  it('more than three agents: the first three and «… 외 N»; an agent the room does not name is «에이전트», never an id', async () => {
    const log = Object.fromEntries(['a1', 'a2', 'a3', 'a4', 'a5'].map((k, i) => [`${k}-0000-4000-8000-00000000000${i}`, { via: 'turn' as const, at: 'x' }]));
    await draw(<DeliveryTimingLine mode="after_turn" log={log} isMine nameOf={() => undefined} />);
    expect(container.textContent).toContain('… 외 2'); expect(container.textContent).not.toMatch(/a1-0000/);
    expect(container.textContent).toContain('에이전트 · 하던 턴에 바로 들어갔어요');
  });
});

describe('the wire', () => {
  it('parseDeliveryMode takes the exact word only', () => {
    expect(parseDeliveryMode('after_turn')).toBe('after_turn');
    for (const v of [undefined, null, 'now', 'AFTER_TURN', 'after-turn', 1, true, ['after_turn'], {}]) expect(parseDeliveryMode(v), String(v)).toBeUndefined();
  });
  it('parseDeliveryLog keeps only closed lines, and nothing left is nothing (never an empty object)', () => {
    expect(parseDeliveryLog({ [A1]: { via: 'turn', at: 't' }, [A2]: { via: 'next_turn', at: 't2' } })).toEqual({ [A1]: { via: 'turn', at: 't' }, [A2]: { via: 'next_turn', at: 't2' } });
    expect(parseDeliveryLog({ [A1]: { via: 'now', at: 't' }, [A2]: { via: 'turn' }, x: 'y', z: null })).toBeUndefined();
    expect(parseDeliveryLog({ [A1]: { via: 'turn', at: 't' }, [A2]: { via: 'later', at: 't' } })).toEqual({ [A1]: { via: 'turn', at: 't' } });
    for (const v of [undefined, null, 'x', 1, [], [{ via: 'turn', at: 't' }]]) expect(parseDeliveryLog(v), String(v)).toBeUndefined();
  });
  it('normalizeToMessage carries both fields and drops what does not fit', () => {
    const m = normalizeToMessage({ id: 'm1', content: 'x', delivery_mode: 'after_turn', delivery_log: { [A1]: { via: 'next_turn', at: 't' } } });
    expect(m.delivery_mode).toBe('after_turn'); expect(m.delivery_log).toEqual({ [A1]: { via: 'next_turn', at: 't' } });
    const old = normalizeToMessage({ id: 'm2', content: 'x' });
    expect(old.delivery_mode).toBeUndefined(); expect(old.delivery_log).toBeUndefined();
  });
});
