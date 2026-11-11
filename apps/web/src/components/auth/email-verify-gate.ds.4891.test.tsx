// @vitest-environment jsdom
//
// story 4891 (UI-8 · the «check your inbox» screen on the ds parts) — the card a person sees right after sign-up while the verification mail is on its way: it is a ds Card, [인증 메일 다시 보내기] is a ds Button that hands the press
// back and locks while sending, the way out «다른 주소로 가입하기» is a ds Button too (quiet, underlined — it is a press, not a sentence), the one-line answer to a resend is a status, and no old `ui/` part is imported on the way.
// What the gate does (when it shows, how it opens in place, the resend and register-again requests) is pinned by `email-verify-gate.test.tsx`, unchanged. The 390 touch measure: `e2e/register-verify-wait.4891.layout.spec.ts`.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { walkOldUi } from '@/components/settings/settings-tab-walk.helper';
import { EmailVerifyGateCard, type VerifyGate } from './email-verify-gate';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(), logoutUser: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.emailVerifyGate;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

type Closed = Extract<VerifyGate, { kind: 'closed' }>;
const gateOf = (over: Partial<Closed> = {}): Closed => ({ kind: 'closed', email: 'jiwoo@example.com', resend: 'idle', sendAgain: vi.fn(), registerAgain: vi.fn(), ...over });
async function draw(gate: Closed) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><EmailVerifyGateCard gate={gate} /></NextIntlClientProvider>); });
}
const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
const btn = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
const oldSlots = () => [...container.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));

describe('[SID:4891] EmailVerifyGateCard on ds parts', () => {
  it('⭐the card is a ds Card; the title is the page’s one h1; the address stands in bold inside the sentence', async () => {
    await draw(gateOf());
    const card = container.querySelector('[data-testid="email-verify-gate"]') as HTMLElement;
    expect(card.getAttribute('data-slot')).toBe('ds-card');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h1')?.textContent).toBe(T.title);
    expect(container.querySelector('strong')?.textContent).toBe('jiwoo@example.com');
  });

  it('⭐[인증 메일 다시 보내기] is a ds Button that hands the press back and is off while sending; «다른 주소로 가입하기» is a ds Button (quiet · underlined) that hands its press back', async () => {
    const g = gateOf();
    await draw(g);
    expect(btn(T.resend).getAttribute('data-slot')).toBe('ds-button');
    expect(btn(T.resend).className.split(/\s+/)).toContain('border-ds-line-control'); // the ds secondary look: the EXACT class token (a substring would also match every variant's «disabled:border-ds-line-control»)
    await act(async () => { btn(T.resend).click(); });
    expect(g.sendAgain).toHaveBeenCalledTimes(1);
    expect(btn(T.otherAddress).getAttribute('data-slot')).toBe('ds-button');
    expect(btn(T.otherAddress).className).toContain('underline');
    await act(async () => { btn(T.otherAddress).click(); });
    expect(g.registerAgain).toHaveBeenCalledTimes(1);
    await draw(gateOf({ resend: 'sending' }));
    expect(btn(T.resend).disabled).toBe(true);
  });

  it('the answer to a resend is a status line (sent · limited · failed), and none before a try', async () => {
    await draw(gateOf());
    expect(container.querySelector('[data-testid="email-verify-gate-resend"]')).toBeNull();
    for (const [resend, text] of [['sent', T.resendSent], ['limited', T.resendLimited], ['failed', T.resendFailed]] as const) {
      await draw(gateOf({ resend }));
      const line = container.querySelector('[data-testid="email-verify-gate-resend"]') as HTMLElement;
      expect(line.getAttribute('role')).toBe('status');
      expect(line.textContent).toBe(text);
    }
  });

  it('nothing old is drawn (data-slot) and the walk of the gate’s imports meets no old ui/ part', async () => {
    await draw(gateOf());
    expect(oldSlots()).toEqual([]);
    const { olds, seen } = walkOldUi([path.join(__dirname, 'email-verify-gate.tsx')]);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(olds, `old ui/ imports in the verify gate:\n${olds.join('\n')}`).toEqual([]);
  });
});
