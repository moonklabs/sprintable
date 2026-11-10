// @vitest-environment jsdom
//
// story #4888(UI-5 보드 · 목록 화면, PO 11-10 20:20Z) — 목록 보기의 «스토리 추가» 입구. 폰 390은 기본 보기가 «목록»인데 만들기 입구가 0이었다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ListStoryComposer } from './list-story-composer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const wrap = (n: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const entry = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.board.addStory));
const input = () => container.querySelector('input') as HTMLInputElement | null;
async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input()!, text);
    input()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => { input()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); });
}

describe('ListStoryComposer', () => {
  it('닫힌 때는 «스토리 추가» 단추 한 줄뿐 — 입력칸 없음', async () => {
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={vi.fn()} />)); });
    expect(entry()).toBeTruthy();
    expect(input()).toBeNull();
  });

  it('⭐누르면 입력칸이 열린다(같은 자리표시 글) · 제목 쓰고 Enter → onCreate(앞뒤 공백 뺀 제목) 한 번 · 닫힘', async () => {
    const onCreate = vi.fn(async () => {});
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={onCreate} />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(input()).not.toBeNull();
    expect(input()!.getAttribute('placeholder')).toBe(koMessages.board.addStoryPlaceholder);
    await type('  폰에서 만든 일감  ');
    await key('Enter');
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('폰에서 만든 일감');
    expect(input()).toBeNull();
    expect(entry()).toBeTruthy();
  });

  it('Esc는 닫기만 한다 — onCreate 안 부름', async () => {
    const onCreate = vi.fn();
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={onCreate} />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await type('안 만들 글');
    await key('Escape');
    expect(onCreate).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it('빈 제목은 만들지 않는다 — 제출 단추 비활성 · Enter 무시', async () => {
    const onCreate = vi.fn();
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={onCreate} />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const submit = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.board.addStorySubmit) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await type('   ');
    await key('Enter');
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('한글 조합 중 Enter는 만들기가 아니다(isComposing) — 조합이 끝난 Enter만', async () => {
    const onCreate = vi.fn();
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={onCreate} />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await type('가나다');
    await key('Enter', { isComposing: true });
    expect(onCreate).not.toHaveBeenCalled();
    await key('Enter');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('만드는 중에 Enter를 또 눌러도 한 번만 부른다', async () => {
    let release!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((r) => { release = r; }));
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={onCreate} />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await type('한 번만');
    await key('Enter');
    await key('Enter');
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
  });

  // codex 5543-2 BLOCKING — 만들기가 실패해도(보드가 오류를 띄우고 false를 돌려준다) 입력칸이 닫히고 제목이 지워지면 쓴 글이 사라진다.
  it('⭐만들기가 실패(false)하면 입력칸과 제목이 그대로 남는다 — 다시 눌러 재시도할 수 있다(되돌리면 RED)', async () => {
    const onCreate = vi.fn(async () => false);
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={onCreate} />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await type('실패해도 남을 글');
    await key('Enter');
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(input()).not.toBeNull();
    expect(input()!.value).toBe('실패해도 남을 글');
    // 재시도: 이번엔 성공 → 닫힘
    onCreate.mockResolvedValueOnce(true as never);
    await key('Enter');
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(input()).toBeNull();
  });

  it('취소 단추도 닫기만 한다', async () => {
    const onCreate = vi.fn();
    await act(async () => { root.render(wrap(<ListStoryComposer onCreate={onCreate} />)); });
    await act(async () => { entry()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.board.addStoryCancel)!;
    await act(async () => { cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(input()).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
