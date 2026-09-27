// @vitest-environment jsdom
/**
 * story #4370 — 스펙 핀 설명 초안: 새 핀(산출물 키) · 고치기(핀 키, 저장된 설명이 처음 값) 모두 창이 Esc로 닫혀도 남고
 * «취소» · 저장/지우기 성공에서만 지운다(예전엔 «ESC/닫기 = 취소»라 쓴 설명이 사라졌다).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PinAuthoringPopover } from './pin-authoring-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const c = koMessages.canvas as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
let saveOk = true;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  saveOk = true;
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };
const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const field = () => document.body.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${c.specPinDescriptionPlaceholder}"]`);
const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label)!;

const ctl: { setOpen?: (v: boolean) => void } = {};
async function mount(mode: 'new' | 'edit') {
  function Parent() {  // edit-canvas처럼 draftPin / editingPin이 있을 때만 마운트
    const [open, setOpen] = useState(false);
    useEffect(() => { ctl.setOpen = setOpen; }, []);
    return (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        {open ? (
          <PinAuthoringPopover
            open
            onOpenChange={(o) => { if (!o) setOpen(false); }}
            initialDescription={mode === 'edit' ? '저장된 설명' : ''}
            onSave={async () => saveOk}
            onDelete={mode === 'edit' ? async () => saveOk : undefined}
            draftKey={mode === 'edit' ? { surface: 'spec-pin-edit', targetId: 'pin-1' } : { surface: 'spec-pin-new', targetId: 'artifact-1' }}
          />
        ) : null}
      </NextIntlClientProvider>
    );
  }
  await act(async () => { root.render(<Parent />); });
}
async function open() { await act(async () => { ctl.setOpen!(true); }); await settle(); }
async function type(text: string) {
  const el = field()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function closeByEsc() {
  await act(async () => { field()!.focus(); });
  await act(async () => { esc(field()!); });
  await act(async () => { esc(document.activeElement ?? document.body); });
  await settle();
}

describe('PinAuthoringPopover 설명 초안(story #4370)', () => {
  it('새 핀: Esc로 닫아도 다시 열면 설명이 남는다 · «취소»는 지운다', async () => {
    await mount('new');
    await open();
    await type('버튼 여백은 12px');
    await closeByEsc();
    expect(field()).toBeNull();
    await open();
    expect(field()!.value).toBe('버튼 여백은 12px');
    await act(async () => { button(c.specPinCancelAction).click(); });
    await settle();
    await open();
    expect(field()!.value).toBe('');
  });

  it('새 핀: 저장 실패는 남기고 · 성공은 지운다', async () => {
    await mount('new');
    await open();
    await type('저장할 설명');
    saveOk = false;
    await act(async () => { button(c.specPinSaveAction).click(); });
    await settle();
    expect(field()!.value).toBe('저장할 설명');
    saveOk = true;
    await act(async () => { button(c.specPinSaveAction).click(); });
    await settle();
    await open();
    expect(field()!.value).toBe('');
  });

  it('고치기: 저장된 설명이 처음 값 · 고친 글은 닫혀도 남고 · 지우기 성공은 지운다', async () => {
    await mount('edit');
    await open();
    expect(field()!.value).toBe('저장된 설명');
    await type('저장된 설명 + 고침');
    await closeByEsc();
    await open();
    expect(field()!.value).toBe('저장된 설명 + 고침');
    await act(async () => { button(c.propertyDeleteAction).click(); });
    await settle();
    await open();
    expect(field()!.value).toBe('저장된 설명');
  });
});
