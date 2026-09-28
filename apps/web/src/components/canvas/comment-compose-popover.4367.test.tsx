// @vitest-environment jsdom
//
// [SID:4367] 한 Esc = 한 층 — 산출물 댓글 쓰기 칸의 Esc는 이 칸만 닫고(폐기 · onCancel) preventDefault로 «썼다»고 표시한다.
// 스토리 패널 안 산출물 카드에서 이 Esc가 패널 window Esc로 흘러 패널째 닫혔다(실 브라우저 판 · 배포 36과 같은 소스).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentComposePopover } from './comment-compose-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

describe('CommentComposePopover — Esc는 이 칸만([SID:4367])', () => {
  it('입력칸에서 Esc → onCancel 한 번 · defaultPrevented 참 · 바깥 window 리스너가 표시를 본다', async () => {
    const onCancel = vi.fn();
    const seen: boolean[] = [];
    const outer = (e: KeyboardEvent) => { if (e.key === 'Escape') seen.push(e.defaultPrevented); };
    window.addEventListener('keydown', outer);
    try {
      await act(async () => {
        root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><CommentComposePopover onSubmit={async () => true} draftTargetId="a1" onCancel={onCancel} /></NextIntlClientProvider>);
      });
      const ta = container.querySelector('textarea')!;
      await act(async () => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([true]);
    } finally {
      window.removeEventListener('keydown', outer);
    }
  });
});

// [SID:4369] 유나 규칙 — 글 있는 칸: 첫 Esc = 칸에서만(폐기 0 · 글 그대로 · 초점 = 칸 틀 · 표시) · 둘째 Esc = 폐기 + 닫기 · 조합 중 Esc = 아무것도 안 함.
describe('CommentComposePopover — 글 있는 칸 Esc 규칙([SID:4369])', () => {
  it('글 쓰고 Esc → 칸에서만 → Esc → 폐기 · 조합 중 Esc는 그대로', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><CommentComposePopover onSubmit={async () => true} draftTargetId="a1" onCancel={onCancel} /></NextIntlClientProvider>);
    });
    const ta = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { ta.focus(); setter.call(ta, '핀 메모 쓰던 글'); ta.dispatchEvent(new Event('input', { bubbles: true })); });
    const esc = (t: EventTarget, init: KeyboardEventInit = {}) => { const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }); t.dispatchEvent(e); return e; };
    await act(async () => { esc(ta, { isComposing: true }); });
    expect(onCancel).not.toHaveBeenCalled();
    let first!: KeyboardEvent;
    await act(async () => { first = esc(ta); });
    expect(onCancel).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(true);
    expect(ta.value).toBe('핀 메모 쓰던 글');
    const frame = ta.parentElement!;
    expect(document.activeElement).toBe(frame);
    await act(async () => { esc(frame); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
