// @vitest-environment jsdom
//
// [SID:4369] 유나 규칙 도우미 — ① 조합 중 Esc = 층 아무것도 안 함 ② 글 있는 여러 줄 칸의 첫 Esc = 칸에서만 빠져나옴(표시 + 초점 = 층 뿌리)
// ③ 글 없음 · 한 줄 칸 = 층이 닫음(도우미는 거짓). 창 · 시트 원형의 guardEscClose도 같은 판(취소 + 초점 = 팝업).
import { afterEach, describe, expect, it } from 'vitest';
import { guardEscClose, isComposingEsc, leaveMultilineFieldOnEsc, multilineFieldWithText } from './inner-layer-esc';

afterEach(() => { document.body.innerHTML = ''; });

function layer(inner: string): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('tabindex', '-1');
  root.innerHTML = inner;
  document.body.appendChild(root);
  return root;
}
const escOn = (target: HTMLElement, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  let seen!: KeyboardEvent;
  target.addEventListener('keydown', (ev) => { seen = ev as KeyboardEvent; }, { once: true });
  target.dispatchEvent(e);
  return seen;
};

describe('inner-layer-esc — 유나 규칙 도우미([SID:4369])', () => {
  it('isComposingEsc — isComposing 또는 keyCode 229', () => {
    expect(isComposingEsc({ isComposing: true })).toBe(true);
    expect(isComposingEsc({ keyCode: 229 })).toBe(true);
    expect(isComposingEsc({ isComposing: false, keyCode: 27 })).toBe(false);
    expect(isComposingEsc(null)).toBe(false);
  });

  it('multilineFieldWithText — 글 있는 textarea · contenteditable만(빈 칸 · 한 줄 input은 null)', () => {
    const root = layer('<textarea id="t">글</textarea><textarea id="e"></textarea><input id="i" value="한 줄"><div id="c" contenteditable="true"><p id="p">편집기 글</p></div>');
    expect(multilineFieldWithText(root.querySelector('#t'))?.id).toBe('t');
    expect(multilineFieldWithText(root.querySelector('#e'))).toBeNull();
    expect(multilineFieldWithText(root.querySelector('#i'))).toBeNull();
    // jsdom은 isContentEditable을 구현하지 않는다 — 속성으로 흉내.
    const c = root.querySelector('#c') as HTMLElement;
    Object.defineProperty(c, 'isContentEditable', { value: true });
    expect(multilineFieldWithText(c)?.id).toBe('c');
  });

  it('② 글 있는 textarea의 Esc → 참 · 표시(defaultPrevented) · 초점 = 층 뿌리 · 글 그대로', () => {
    const root = layer('<textarea id="t">쓰던 글</textarea>');
    const t = root.querySelector('textarea')!;
    t.focus();
    let handled = false;
    t.addEventListener('keydown', (e) => { handled = leaveMultilineFieldOnEsc(e, root); });
    const e = escOn(t);
    expect(handled).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root);
    expect(t.value).toBe('쓰던 글');
  });

  it('③ 빈 textarea · 한 줄 input(글 있어도) → 거짓(층이 닫음) · 표시 없음', () => {
    const root = layer('<textarea id="t"></textarea><input id="i" value="한 줄 글">');
    for (const sel of ['#t', '#i']) {
      const el = root.querySelector(sel) as HTMLElement;
      el.focus();
      let handled = true;
      el.addEventListener('keydown', (e) => { handled = leaveMultilineFieldOnEsc(e, root); }, { once: true });
      const e = escOn(el);
      expect(handled, sel).toBe(false);
      expect(e.defaultPrevented, sel).toBe(false);
    }
  });

  it('① 조합 중 Esc → 참(층 아무것도 안 함) · 표시 안 함(IME가 조합 취소) · 초점 그대로', () => {
    const root = layer('<textarea>한</textarea>');
    const t = root.querySelector('textarea')!;
    t.focus();
    let handled = false;
    t.addEventListener('keydown', (e) => { handled = leaveMultilineFieldOnEsc(e, root); });
    const e = escOn(t, { isComposing: true });
    expect(handled).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(t);
  });

  it('층 밖 칸은 이 층 일이 아니다(거짓)', () => {
    const root = layer('<button>안</button>');
    const outside = document.createElement('textarea');
    outside.value = '밖 글';
    document.body.appendChild(outside);
    outside.focus();
    let handled = true;
    outside.addEventListener('keydown', (e) => { handled = leaveMultilineFieldOnEsc(e, root); });
    escOn(outside);
    expect(handled).toBe(false);
  });

  it('guardEscClose — escape-key만 · 표시된 Esc · 조합 · 글 있는 여러 줄 칸이면 취소 · 그 밖은 통과', () => {
    const popup = layer('<textarea id="t">글</textarea><textarea id="e"></textarea>');
    popup.setAttribute('data-slot', 'dialog-content');
    const det = (event: Event | undefined, reason = 'escape-key') => { let canceled = false; return { reason, event, cancel: () => { canceled = true; }, get canceled() { return canceled; } }; };
    const t = popup.querySelector('#t') as HTMLTextAreaElement;
    const ev = (target: HTMLElement, init: KeyboardEventInit = {}) => { const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...init }); Object.defineProperty(e, 'target', { value: target }); return e; };

    const d1 = det(ev(t)); expect(guardEscClose(false, d1)).toBe(true); expect(d1.canceled).toBe(true); expect(document.activeElement).toBe(popup);
    const d2 = det(ev(popup.querySelector('#e') as HTMLElement)); popup.focus(); expect(guardEscClose(false, d2)).toBe(false); expect(d2.canceled).toBe(false);
    const d3 = det(ev(t, { isComposing: true })); expect(guardEscClose(false, d3)).toBe(true); expect(d3.canceled).toBe(true);
    const d4 = det(ev(t), 'outside-press'); expect(guardEscClose(false, d4)).toBe(false);
    const d5 = det(ev(t)); expect(guardEscClose(true, d5)).toBe(false);
  });
});
