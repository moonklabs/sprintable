// @vitest-environment jsdom
//
// story 4831 (측정 중 찾은 기존 결함) — 캔버스 코멘트 쓰기 팝오버와 스레드 답글 칸의 엔터는 «보내기»인데, 한글 조합 중의 엔터는 «글자 확정 키»다.
// 실제 Chromium 실측(전): 코멘트 쓰기는 반쯤 쓴 «이 버튼 위치가 좀 어색»이 나가고 칸이 비워져 확정된 «해요»가 코멘트로 또 나갔고(2건),
// 스레드 답글은 «확인했어»와 «요»가 답글 둘로 나갔다. 조합 중(isComposing · keyCode 229)의 엔터는 보내지 않고 기본 동작도 막지 않으며,
// 조합이 아닌 엔터는 그대로 한 번 보낸다(시프트+엔터는 그대로 줄바꿈).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentComposePopover } from './comment-compose-popover';
import { CommentThreadCard } from './comment-thread-card';
import { MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS } from '@/services/canvas-comments';

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

const mount = async (node: React.ReactNode) => {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
};
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function key(el: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

describe('캔버스 코멘트 쓰기 팝오버 — 한글 조합 중 엔터(story 4831)', () => {
  it('조합 중의 엔터(isComposing · keyCode 229)는 보내지 않고 기본 동작도 막지 않으며 칸의 글도 그대로다', async () => {
    const onSubmit = vi.fn(async () => true);
    await mount(<CommentComposePopover onSubmit={onSubmit} onCancel={() => {}} draftTargetId="a1" />);
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { setValue(field, '이 버튼 위치가 좀 어색'); });
    let ev!: KeyboardEvent;
    await act(async () => { ev = key(field, { isComposing: true }); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    await act(async () => { key(field, { keyCode: 229 }); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field.value).toBe('이 버튼 위치가 좀 어색');
  });
  it('조합이 끝난 뒤의 엔터는 확정된 글을 한 번 보낸다', async () => {
    const onSubmit = vi.fn(async () => true);
    await mount(<CommentComposePopover onSubmit={onSubmit} onCancel={() => {}} draftTargetId="a1" />);
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => { setValue(field, '이 버튼 위치가 좀 어색해요'); });
    await act(async () => { key(field); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('이 버튼 위치가 좀 어색해요');
  });
});

describe('캔버스 스레드 답글 칸 — 한글 조합 중 엔터(story 4831)', () => {
  const thread = MOCK_THREADS.find((t) => t.rollup === 'open')!;
  it('조합 중의 엔터는 답글을 보내지 않고 기본 동작도 막지 않으며 칸의 글도 그대로다', async () => {
    const onReply = vi.fn();
    await mount(<CommentThreadCard thread={thread} memberMap={MOCK_MEMBERS} onReply={onReply} />);
    const input = container.querySelector(`input[placeholder="${(koMessages.canvas as Record<string, string>).replyPlaceholder}"]`) as HTMLInputElement;
    await act(async () => { setValue(input, '확인했어'); });
    let ev!: KeyboardEvent;
    await act(async () => { ev = key(input, { isComposing: true }); });
    expect(onReply).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    await act(async () => { key(input, { keyCode: 229 }); });
    expect(onReply).not.toHaveBeenCalled();
    expect(input.value).toBe('확인했어');
  });
  it('조합이 끝난 뒤의 엔터는 확정된 글을 한 번 보낸다', async () => {
    const onReply = vi.fn();
    await mount(<CommentThreadCard thread={thread} memberMap={MOCK_MEMBERS} onReply={onReply} />);
    const input = container.querySelector(`input[placeholder="${(koMessages.canvas as Record<string, string>).replyPlaceholder}"]`) as HTMLInputElement;
    await act(async () => { setValue(input, '확인했어요'); });
    await act(async () => { key(input); });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(thread.id, '확인했어요');
  });
});
