// UI-3(a9d56577) — ds Checkbox 회귀가드: 이름 필수 · 스페이스만 토글 · 일부 선택은 글리프 · 비활성.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
const wrap = (n: ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
async function render(n: ReactNode) { await act(async () => { root.render(wrap(n)); }); }
async function press(el: Element, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
}
import { Checkbox } from './checkbox';

const box = () => container.querySelector('[role="checkbox"]') as HTMLElement;

function Controlled({ onChange }: { onChange: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return <Checkbox label="알림 받기" checked={on} onCheckedChange={(v) => { setOn(v); onChange(v); }} />;
}

describe('ds Checkbox', () => {
  it('보이는 이름이 있고 누르는 줄 전체가 label이다(이름 글을 눌러도 켜진다)', async () => {
    await render(<Controlled onChange={() => {}} />);
    expect(container.querySelector('label')!.textContent).toContain('알림 받기');
    expect(box().tabIndex).toBe(0);
  });

  it('⭐뿌리(role=checkbox)의 접근성 이름이 보이는 이름 글이다(aria-labelledby → 이름 span)', async () => {
    await render(<Controlled onChange={() => {}} />);
    const id = box().getAttribute('aria-labelledby')!;
    expect(id).toBeTruthy();
    const target = document.getElementById(id)!;
    // Base UI는 감싼 <label>을 스스로 가리킬 수도 있다 — 우리가 명시한 «이름 span»을 가리켜야 한다(레이블 전체가 아니라).
    expect(target.tagName).toBe('SPAN');
    expect(target.textContent).toBe('알림 받기');
  });

  it('⭐스페이스로 켜고 끈다 · 엔터로는 켜지지 않는다(날것 checkbox와 같음)', async () => {
    const seen: boolean[] = [];
    await render(<Controlled onChange={(v) => seen.push(v)} />);
    box().focus();
    await press(box(), 'Enter');
    expect(seen).toEqual([]);
    await press(box(), ' ');
    expect(seen).toEqual([true]);
    expect(box().getAttribute('aria-checked')).toBe('true');
    await press(box(), ' ');
    expect(seen).toEqual([true, false]);
  });

  it('켜짐은 체크 글리프, 일부 선택은 가로선 글리프(색만으로 안 읽힘)', async () => {
    await render(<Checkbox label="전체" defaultChecked />);
    expect(box().querySelector('[data-icon="check"]')).not.toBeNull();
    await render(<Checkbox label="전체" indeterminate />);
    expect(box().querySelector('[data-icon="remove"]')).not.toBeNull();
    expect(box().querySelector('[data-icon="check"]')).toBeNull();
  });

  it('비활성은 스페이스에도 안 바뀌고 점선 윤곽 클래스를 가진다', async () => {
    const seen: boolean[] = [];
    await render(<Checkbox label="x" disabled checked={false} onCheckedChange={(v) => seen.push(v)} />);
    await press(box(), ' ');
    expect(seen).toEqual([]);
    expect(box().className).toContain('data-disabled:border-dashed');
  });

  it('⭐비활성 + 켜짐 · 일부 선택은 활성 색(action 면)을 잃는다 — 켜진 상태는 글리프로만 남는다', async () => {
    await render(<Checkbox label="x" disabled defaultChecked />);
    const cls = box().className;
    expect(cls).toContain('data-disabled:data-checked:bg-transparent');
    expect(cls).toContain('data-disabled:data-checked:border-ds-line-control');
    expect(cls).toContain('data-disabled:data-indeterminate:bg-transparent');
    expect(box().querySelector('[data-icon="check"]')).not.toBeNull();
  });

  it('초점 링은 action 2px · 경계는 line-control', async () => {
    await render(<Checkbox label="x" />);
    expect(box().className).toContain('focus-visible:ring-ds-action');
    expect(box().className).toMatch(/(^|\s)border-ds-line-control(\s|$)/);
  });
});
