// @vitest-environment jsdom
/**
 * story #4370(유나 판정 (가)) — 루프 만들기 창: 여러 줄 칸(가설 문장)이 든 폼이라 폼 전체가 프로젝트별 초안 하나.
 * 예전엔 닫힐 때 reset()이 폼을 통째로 비웠다. 이제 창이 Esc로 닫혀도 다시 열면 그대로 · 만들기 성공에서만 지운다(이 창엔 «취소»가 없다).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { LoopCreateDialog } from './loop-create-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const l = (koMessages as unknown as Record<string, Record<string, string>>).loops;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/loops' && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'loop-1' }) };
    return { ok: false, json: async () => ({}) };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };
const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const titleInput = () => document.body.querySelector<HTMLInputElement>(`input[placeholder="${l.createLoopFormTitlePlaceholder}"]`);
const statement = () => document.body.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${l.createLoopStatementPlaceholder}"]`);

const ctl: { setOpen?: (v: boolean) => void } = {};
async function mount() {
  function Parent() {  // loops-client처럼 늘 마운트 · open prop
    const [open, setOpen] = useState(false);
    useEffect(() => { ctl.setOpen = setOpen; }, []);
    return (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <LoopCreateDialog projectId="proj-1" open={open} onOpenChange={setOpen} onCreated={() => {}} />
      </NextIntlClientProvider>
    );
  }
  await act(async () => { root.render(<Parent />); });
}
async function open() { await act(async () => { ctl.setOpen!(true); }); await settle(); }
async function setValue(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function closeByEsc() {
  await act(async () => { statement()!.focus(); });
  await act(async () => { esc(statement()!); });
  await act(async () => { esc(document.activeElement ?? document.body); });
  await settle();
}

describe('루프 만들기 창 폼 초안(story #4370)', () => {
  it('Esc로 닫고 다시 열면 제목 · 가설 문장이 남아 있다(예전 reset() 폐기 0)', async () => {
    await mount();
    await open();
    await setValue(titleInput()!, '결제 전환 루프');
    await setValue(statement()!, '결제 단계를 줄이면\n전환이 오른다');
    await closeByEsc();
    expect(statement()).toBeNull();
    await open();
    expect(titleInput()!.value).toBe('결제 전환 루프');
    expect(statement()!.value).toBe('결제 단계를 줄이면\n전환이 오른다');
  });

  it('보이는 «취소»는 폼 초안을 버리고 닫는다(까디르 P3)', async () => {
    await mount();
    await open();
    await setValue(titleInput()!, '버릴 루프');
    await setValue(statement()!, '버릴 가설');
    const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === koMessages.common.cancel)!;
    await act(async () => { cancel.click(); });
    await settle();
    expect(statement()).toBeNull();
    await open();
    expect(titleInput()!.value).toBe('');
    expect(statement()!.value).toBe('');
  });
});

