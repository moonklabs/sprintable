// UI-3(a9d56577) — ds Toggle 회귀가드: 이름 + 켬/끔 글 · 상태 글이 값을 따라감 · 스페이스 · 비활성.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
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
import { Toggle } from './toggle';

const sw = () => container.querySelector('[role="switch"]') as HTMLElement;
const stateText = () => container.querySelector('[data-slot="ds-toggle-state"]')!.textContent;

describe('ds Toggle', () => {
  it('⭐이름과 상태 글(꺼짐 «끔»)이 보인다 — 색 · 위치만으로 읽지 않는다', async () => {
    await render(<Toggle label="원격 제어" onText="켬" offText="끔" />);
    expect(container.querySelector('label')!.textContent).toContain('원격 제어');
    expect(stateText()).toBe('끔');
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });

  it('⭐상태 글은 aria-hidden — 스위치 이름에 섞이지 않는다(aria-checked로 읽히므로 두 번 읽히지 않게)', async () => {
    await render(<Toggle label="원격 제어" onText="켬" offText="끔" />);
    expect(container.querySelector('[data-slot="ds-toggle-state"]')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('⭐스위치 뿌리(role=switch)의 접근성 이름은 이름 글뿐이다 — 상태 글(끔/켬)은 섞이지 않는다', async () => {
    await render(<Toggle label="원격 제어" onText="켬" offText="끔" />);
    expect(document.getElementById(sw().getAttribute('aria-labelledby')!)!.textContent).toBe('원격 제어');
  });

  it('비제어: 눌러 켜면 상태 글이 «켬»으로 바뀌고 onCheckedChange가 불린다', async () => {
    const seen: boolean[] = [];
    await render(<Toggle label="x" onText="켬" offText="끔" onCheckedChange={(v) => seen.push(v)} />);
    sw().focus();
    await act(async () => { sw().click(); });
    expect(seen).toEqual([true]);
    expect(stateText()).toBe('켬');
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('제어형: checked 값을 글로 따라간다(안에서 세지 않는다)', async () => {
    await render(<Toggle label="x" onText="켬" offText="끔" checked />);
    expect(stateText()).toBe('켬');
    await render(<Toggle label="x" onText="켬" offText="끔" checked={false} />);
    expect(stateText()).toBe('끔');
  });

  it('Tab으로 들어올 수 있는 한 칸이고 role=switch다', async () => {
    await render(<Toggle label="x" onText="켬" offText="끔" />);
    expect(sw().tabIndex).toBe(0);
    sw().focus();
    expect(document.activeElement).toBe(sw());
  });

  it('비활성: 점선 윤곽 클래스 · 클릭해도 안 바뀐다', async () => {
    const seen: boolean[] = [];
    await render(<Toggle label="x" onText="켬" offText="끔" disabled onCheckedChange={(v) => seen.push(v)} />);
    expect(sw().className).toContain('data-disabled:border-dashed');
    expect(sw().className).toContain('data-disabled:data-checked:bg-transparent');
    expect(sw().querySelector('span')!.className).toContain('group-data-[disabled]/toggle:data-checked:bg-ds-ink-3');
    await act(async () => { sw().click(); });
    expect(seen).toEqual([]);
    expect(stateText()).toBe('끔');
  });

  it('⭐호출부가 바꿈을 취소(details.cancel)하면 상태 글도 그대로다 — 글과 실제 상태가 갈리지 않는다', async () => {
    await render(<Toggle label="x" onText="켬" offText="끔" onCheckedChange={(_v, details) => details.cancel()} />);
    await act(async () => { sw().click(); });
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(stateText()).toBe('끔');
  });
});
