// @vitest-environment jsdom
/**
 * story #4370 — 산출물 댓글 쓰기 칸 초안(유나 규칙: Esc는 여러 줄 글을 안 버림 · 버림은 보이는 «취소»로만 · 성공에서 지움).
 * 4369 뒤에도 둘째 Esc = 쓴 글 폐기 + 닫기였다(유나 4751 판). 이제 둘째 Esc · 바깥 누름은 닫기만(초안으로 남음) — 다시 열면(팝오버 재마운트) 그대로.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentComposePopover } from './comment-compose-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onCancel: Mock<() => void>;
let submitResult = true;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onCancel = vi.fn<() => void>();
  submitResult = true;
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const c = koMessages.canvas as Record<string, string>;
const field = () => container.querySelector<HTMLTextAreaElement>('textarea');
const btn = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label)!;
const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const frame = async () => { await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); }); };

async function open(artifactId = 'a1') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <CommentComposePopover onSubmit={async () => submitResult} onCancel={onCancel} draftTargetId={artifactId} />
      </NextIntlClientProvider>,
    );
  });
  await frame();  // 바깥 누름 리스너는 다음 프레임에 붙는다
}
async function close() { await act(async () => { root.render(<></>); }); }  // 호출부가 onCancel에서 팝오버를 내림
async function type(text: string) {
  const el = field()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('CommentComposePopover 초안(story #4370)', () => {
  it('둘째 Esc는 닫기만 — 다시 열면 쓴 글 그대로', async () => {
    await open();
    await type('핀 댓글 초안');
    await act(async () => { field()!.focus(); });
    await act(async () => { esc(field()!); });                               // 첫 Esc — 칸에서만(4369)
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => { esc(document.activeElement ?? container); });    // 둘째 Esc — 닫기
    expect(onCancel).toHaveBeenCalledTimes(1);
    await close();
    await open();
    expect(field()!.value).toBe('핀 댓글 초안');
  });

  it('바깥 누름으로 닫혀도 남는다', async () => {
    await open();
    await type('바깥 누름 전 글');
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    await close();
    await open();
    expect(field()!.value).toBe('바깥 누름 전 글');
  });

  it('보이는 «취소»는 지운다', async () => {
    await open();
    await type('버릴 글');
    await act(async () => { btn(c.newThreadCancelAction).click(); });
    await close();
    await open();
    expect(field()!.value).toBe('');
  });

  it('보내기 실패는 남기고 · 성공은 지운다', async () => {
    await open();
    await type('보낼 글');
    submitResult = false;
    await act(async () => { btn(c.newThreadSubmitAction).click(); });
    await close();
    await open();
    expect(field()!.value).toBe('보낼 글');
    submitResult = true;
    await act(async () => { btn(c.newThreadSubmitAction).click(); });
    await close();
    await open();
    expect(field()!.value).toBe('');
  });

  it('다른 산출물 칸엔 안 샌다', async () => {
    await open('a1');
    await type('a1 댓글');
    await close();
    await open('a2');
    expect(field()!.value).toBe('');
  });
});
