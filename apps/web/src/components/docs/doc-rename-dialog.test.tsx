// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { DocRenameDialog } from './doc-rename-dialog';

// story #4359 — 문서 트리 «이름 변경»의 디자인 창(예전 브라우저 prompt('Enter new title:') · 영어 고정).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render(props: { onSubmit?: (v: string) => void; onClose?: () => void; locale?: 'ko' | 'en' } = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const locale = props.locale ?? 'ko';
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages}>
        <DocRenameDialog open currentTitle="회의록" onClose={onClose} onSubmit={onSubmit} />
      </NextIntlClientProvider>,
    );
  });
  return { onSubmit, onClose };
}
const input = () => document.querySelector('[data-testid="doc-rename-input"]') as HTMLInputElement;
const save = () => document.querySelector('[data-testid="doc-rename-save"]') as HTMLButtonElement;
async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('DocRenameDialog — story #4359', () => {
  it('⭐열리면 지금 제목이 든 입력에 초점 · 창 제목은 로케일 문구(ko · en)', async () => {
    await render();
    expect(input().value).toBe('회의록');
    expect(document.activeElement).toBe(input());
    expect(document.querySelector('[data-testid="doc-rename-dialog"]')?.textContent).toContain(koMessages.docs.docTreeRename);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ locale: 'en' });
    expect(document.querySelector('[data-testid="doc-rename-dialog"]')?.textContent).toContain(enMessages.docs.docTreeRename);
  });

  it('⭐빈 이름(공백만) · 바뀌지 않은 이름은 저장이 잠긴다', async () => {
    await render();
    expect(save().disabled).toBe(true);
    await type('   ');
    expect(save().disabled).toBe(true);
    await type('새 회의록');
    expect(save().disabled).toBe(false);
  });

  it('⭐Enter로 저장(앞뒤 공백 걷음) · 저장하면 창을 닫는다', async () => {
    const { onSubmit, onClose } = await render();
    await type('  새 회의록 ');
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onSubmit).toHaveBeenCalledWith('새 회의록');
    expect(onClose).toHaveBeenCalled();
  });

  it('⭐Esc는 저장 없이 닫는다', async () => {
    const { onSubmit, onClose } = await render();
    await type('다른 이름');
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
