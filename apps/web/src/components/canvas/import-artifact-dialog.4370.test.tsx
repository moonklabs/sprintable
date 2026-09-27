// @vitest-environment jsdom
/**
 * story #4370 — 산출물 가져오기 창의 HTML 붙여넣기(여러 줄 칸) 초안: 닫혀도(✕ · 바깥 · Esc) 남고 «취소» · 가져오기 성공에서만 지운다.
 * 예전엔 거꾸로(Dialog 자체 닫힘에서만 비우고 «취소»는 남김). 두 자리를 다 잰다 — 스토리 패널(늘 마운트 · open prop)과 갤러리(조건부 마운트).
 * 남은 초안이 있으면 다시 열었을 때 HTML 탭이 보인다(숨은 초안 0).
 * 유나 판정 (가) — 여러 줄 칸이 든 폼은 폼 전체가 초안 하나: 올린 이미지(탭 · URL)도 닫혀도 남는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ImportArtifactDialog } from './import-artifact-dialog';

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

const c = koMessages.canvas as Record<string, string>;
const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };
const htmlField = () => document.body.querySelector<HTMLTextAreaElement>('textarea');
const btn = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);

const ctl: { setOpen?: (v: boolean) => void } = {};
let importResult = true;

async function mount(mode: 'always' | 'conditional') {
  function Harness() {
    const [open, setOpen] = useState(false);
    useEffect(() => { ctl.setOpen = setOpen; }, []);
    const dialog = (
      <ImportArtifactDialog
        open={mode === 'always' ? open : true}
        onOpenChange={(next) => { if (!next) setOpen(false); }}
        onImport={async () => importResult}
        targetId="story-1"
      />
    );
    return (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        {mode === 'always' ? dialog : open ? dialog : null}
      </NextIntlClientProvider>
    );
  }
  await act(async () => { root.render(<Harness />); });
}
async function open() { await act(async () => { ctl.setOpen!(true); }); await settle(); }
async function toHtmlTab() { await act(async () => { btn(c.importTabHtml)!.click(); }); await settle(); }
async function type(text: string) {
  const el = htmlField()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function closeByEsc() {
  await act(async () => { htmlField()!.focus(); });
  await act(async () => { esc(htmlField()!); });
  await act(async () => { esc(document.activeElement ?? document.body); });
  await settle();
}

describe.each(['always', 'conditional'] as const)('ImportArtifactDialog HTML 초안(story #4370) — %s 마운트', (mode) => {
  it('Esc로 닫아도 다시 열면 HTML 탭에 붙여넣은 글이 남아 있다', async () => {
    await mount(mode);
    await open();
    await toHtmlTab();
    await type('<p>붙여넣은 시안</p>');
    await closeByEsc();
    expect(htmlField()).toBeNull();
    await open();
    expect(htmlField()?.value).toBe('<p>붙여넣은 시안</p>');  // HTML 탭이 곧바로 보임(숨은 초안 0)
  });

  it('«취소»는 지운다', async () => {
    await mount(mode);
    await open();
    await toHtmlTab();
    await type('<p>버릴 시안</p>');
    await act(async () => { btn(c.specPinCancelAction)!.click(); });
    await settle();
    await open();
    await toHtmlTab();
    expect(htmlField()!.value).toBe('');
  });

  it('가져오기 실패는 남기고 · 성공은 지운다', async () => {
    await mount(mode);
    await open();
    await toHtmlTab();
    await type('<p>가져올 시안</p>');
    importResult = false;
    await act(async () => { btn(c.importConfirmAction)!.click(); });
    await settle();
    expect(htmlField()!.value).toBe('<p>가져올 시안</p>');
    importResult = true;
    await act(async () => { btn(c.importConfirmAction)!.click(); });
    await settle();
    await open();
    await toHtmlTab();
    expect(htmlField()!.value).toBe('');
  });
});

describe('ImportArtifactDialog 폼 초안 — 올린 이미지(유나 판정 (가))', () => {
  it('이미지를 올린 뒤 Esc로 닫아도 다시 열면 그 이미지로 가져오기가 바로 된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: 'https://cdn.example.com/kept.png' } }) })));
    try {
      await mount('always');
      await open();
      const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['fake'], 'design.png', { type: 'image/png' });
      await act(async () => {
        Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve(); await Promise.resolve();
      });
      const confirm = () => btn(c.importConfirmAction)!;
      expect(confirm().hasAttribute('disabled')).toBe(false);
      await act(async () => { esc(document.activeElement ?? document.body); });  // 글 칸 초점 없음 — 한 번에 닫힘
      await settle();
      expect(document.body.querySelector('input[type="file"]')).toBeNull();
      await open();
      expect(confirm().hasAttribute('disabled')).toBe(false);  // 올린 이미지가 남아 있어 바로 가져오기
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
