// @vitest-environment jsdom
//
// story 5032 (C2 · PO 11-27, the second look at 390) — a CHANNEL's people button draws two counts apart («사람 2 · 에이전트 1», each with its own glyph and name) instead of one number that left people and agents
// indistinguishable; any other room keeps the single number.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { RoomBarTitle, RoomHead } from './room-head';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(parts?: { people: number; agents: number; spoken: string }) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <RoomBarTitle backLabel="대화" onBack={() => {}} title="런칭" peopleLabel="참여자 보기" peopleCount={3} peopleParts={parts} chips={[]} addLabel="추가" />
      </NextIntlClientProvider>,
    );
  });
}
const btn = () => container.querySelector('[data-testid="room-bar-people"]') as HTMLElement;

describe('RoomBarTitle — the people button (story 5032)', () => {
  it('⭐ a channel: two counts apart, each named for the reader («사람 2 · 에이전트 1») with its own glyph', async () => {
    await mount({ people: 2, agents: 1, spoken: '사람 2 · 부를 수 있는 에이전트 1' });
    expect(btn().querySelector('[data-testid="room-bar-people-humans"]')?.textContent).toBe('2'); // reverted → one number «3»
    expect(btn().querySelector('[data-testid="room-bar-people-agents"]')?.textContent).toBe('1');
    expect(btn().textContent).toContain('참여자 보기');
    expect(btn().textContent).toContain('사람 2 · 부를 수 있는 에이전트 1'); // the reader hears the channel head's own line; the glyphs + numbers are hidden from it
    expect(btn().querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2);
    // the drawn glyphs + numbers are hidden from a screen reader: the two count groups are aria-hidden, the sr-only line is not
    for (const id of ['room-bar-people-humans', 'room-bar-people-agents']) expect(btn().querySelector(`[data-testid="${id}"]`)!.parentElement!.getAttribute('aria-hidden')).toBe('true');
    expect(btn().querySelector('.sr-only[class]:not([aria-hidden])')?.textContent).toBeTruthy();
    expect(btn().querySelector('[data-icon="person"]')).not.toBeNull();
    expect(btn().querySelector('[data-icon="smart_toy"]')).not.toBeNull();
  });

  it('the folded desktop head (a short window) forwards the two counts too', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('max-height: 600px'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    try {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <RoomHead chips={[]} addLabel="추가" peopleLabel="참여자 보기" peopleCount={3} peopleParts={{ people: 2, agents: 1, spoken: '사람 2 · 부를 수 있는 에이전트 1' }} />
          </NextIntlClientProvider>,
        );
      });
      expect(btn().querySelector('[data-testid="room-bar-people-humans"]')?.textContent).toBe('2'); // reverted (peopleParts not forwarded) → one number
      expect(btn().querySelector('[data-testid="room-bar-people-agents"]')?.textContent).toBe('1');
    } finally {
      window.matchMedia = real;
    }
  });

  it('any other room keeps the one number', async () => {
    await mount(undefined);
    expect(btn().querySelector('[data-testid="room-bar-people-parts"]')).toBeNull();
    expect(btn().textContent).toContain('3');
  });
});
