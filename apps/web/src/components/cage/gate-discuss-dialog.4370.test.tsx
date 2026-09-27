// @vitest-environment jsdom
/**
 * story #4370 — «보류(논의 필요)» 사유 초안(유나 규칙: 닫는 길과 무관하게 유지 · 보이는 «취소»와 성공에서만 지움).
 * 예전엔 거꾸로였다: Dialog 자체 닫힘(✕ · 바깥 · Esc)에서만 지우고, «취소»(부모 onOpenChange 직접)와 성공(open prop)은 남겨 다시 열면 옛 글.
 * 받은함은 창 하나를 모든 게이트가 공유해 한 게이트에 쓴 사유가 다른 게이트 창에 떴다 — 게이트별 초안 키로 막는다.
 * 닫힘은 실제 사용 순서(칸에 초점 → Esc 두 번: 첫 Esc는 칸에서만 · 둘째가 창을 닫음, 4369)로 일으킨다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { GateDiscussDialog } from './gate-discuss-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const field = () => document.body.querySelector<HTMLTextAreaElement>('#gate-discuss-reason');
const buttons = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'));
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };

const ctl: { open?: (id: string) => void } = {};
let submitResult = true;

async function mount() {
  function Harness() {
    const [target, setTarget] = useState<string | null>(null);
    useEffect(() => { ctl.open = setTarget; }, []);
    return (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <GateDiscussDialog
          open={target !== null}
          onOpenChange={(open) => { if (!open) setTarget(null); }}
          onSubmit={async () => { if (submitResult) setTarget(null); return submitResult; }}
          submitting={false}
          targetId={target}
        />
      </NextIntlClientProvider>
    );
  }
  await act(async () => { root.render(<Harness />); });
}

async function openFor(id: string) { await act(async () => { ctl.open!(id); }); await settle(); }
async function type(text: string) {
  const el = field()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function closeByEsc() {
  await act(async () => { field()!.focus(); });
  await act(async () => { esc(field()!); });                             // 첫 Esc — 칸에서만(4369)
  await act(async () => { esc(document.activeElement ?? document.body); }); // 둘째 Esc — 창 닫힘(Dialog 자체 onOpenChange)
  await settle();
}
const clickText = async (label: string) => {
  const b = buttons().find((x) => x.textContent?.trim() === label)!;
  await act(async () => { b.click(); });
  await settle();
};

describe('GateDiscussDialog 사유 초안(story #4370)', () => {
  it('Esc(창 자체 닫힘)로 닫아도 다시 열면 사유가 남아 있다', async () => {
    await mount();
    await openFor('gate-a');
    await type('논의가 필요한 이유');
    await closeByEsc();
    expect(field()).toBeNull();
    await openFor('gate-a');
    expect(field()!.value).toBe('논의가 필요한 이유');
  });

  it('보이는 «취소»는 지운다 — 다시 열면 빈 칸', async () => {
    await mount();
    await openFor('gate-a');
    await type('버릴 사유');
    await clickText(koMessages.cage.cancel);
    await openFor('gate-a');
    expect(field()!.value).toBe('');
  });

  it('보내기 성공은 지우고 · 실패는 남긴다', async () => {
    await mount();
    await openFor('gate-a');
    await type('보낼 사유');
    submitResult = false;
    await clickText(koMessages.cage.gateDiscussSubmit);
    expect(field()!.value).toBe('보낼 사유');  // 실패 — 창 그대로 · 글 그대로
    submitResult = true;
    await clickText(koMessages.cage.gateDiscussSubmit);
    await openFor('gate-a');
    expect(field()!.value).toBe('');
  });

  it('공유 창: 게이트 A에 쓴 사유가 게이트 B 창에 안 뜬다 · A로 돌아오면 A 사유', async () => {
    await mount();
    await openFor('gate-a');
    await type('A 게이트 사유');
    await closeByEsc();
    await openFor('gate-b');
    expect(field()!.value).toBe('');
    await closeByEsc();
    await openFor('gate-a');
    expect(field()!.value).toBe('A 게이트 사유');
  });
});
