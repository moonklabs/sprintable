// UI-3(a9d56577) — ds Radio 회귀가드: 이름 필수 · 스페이스로 고름 · 한 번에 하나 · 화살표 이동.
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
import { Radio, RadioGroup } from './radio';

const radios = () => [...container.querySelectorAll('[role="radio"]')] as HTMLElement[];

function Three({ initial, onValue }: { initial: string | null; onValue: (v: string) => void }) {
  const [v, setV] = useState<string | null>(initial);
  return (
    <RadioGroup aria-label="순서" value={v ?? undefined} onValueChange={(next) => { setV(next as string); onValue(next as string); }}>
      <Radio value="a" label="하나" />
      <Radio value="b" label="둘" />
      <Radio value="c" label="셋" />
    </RadioGroup>
  );
}

describe('ds Radio', () => {
  it('항목마다 보이는 이름이 있다', async () => {
    await render(<Three initial={null} onValue={() => {}} />);
    expect([...container.querySelectorAll('label')].map((l) => l.textContent)).toEqual(['하나', '둘', '셋']);
  });

  it('⭐아무것도 안 골라진 묶음에서 초점 있는 항목에 스페이스를 누르면 그 항목이 골라진다', async () => {
    const seen: string[] = [];
    await render(<Three initial={null} onValue={(v) => seen.push(v)} />);
    const first = radios().find((r) => r.tabIndex === 0)!;
    first.focus();
    await press(first, ' ');
    expect(seen).toHaveLength(1);
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('한 번에 하나만 골라진다 · 고른 점은 action 윤곽 클래스를 가진다', async () => {
    await render(<Three initial="b" onValue={() => {}} />);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios()[1]!.className).toContain('data-checked:border-ds-action');
  });

  it('다른 항목에 초점을 옮겨 스페이스를 누르면 그 항목으로 옮겨 간다', async () => {
    const seen: string[] = [];
    await render(<Three initial="a" onValue={(v) => seen.push(v)} />);
    radios()[2]!.focus();
    await press(radios()[2]!, ' ');
    expect(seen).toEqual(['c']);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
  });

  it('비활성 항목은 점선 윤곽 클래스를 가진다', async () => {
    await render(<RadioGroup aria-label="묶음"><Radio value="a" label="x" disabled /></RadioGroup>);
    expect(radios()[0]!.className).toContain('data-disabled:border-dashed');
  });

  it('⭐비활성 + 고른 항목은 action 윤곽을 잃는다(점은 ink-3)', async () => {
    await render(<RadioGroup aria-label="묶음" defaultValue="a"><Radio value="a" label="x" disabled /></RadioGroup>);
    expect(radios()[0]!.className).toContain('data-disabled:data-checked:border-ds-line-control');
    expect(container.querySelector('[data-slot="ds-radio-indicator"]')!.className).toContain('data-disabled:bg-ds-ink-3');
  });

  it('⭐항목 뿌리(role=radio)의 접근성 이름이 보이는 이름 글이다', async () => {
    await render(<Three initial={null} onValue={() => {}} />);
    const targets = radios().map((r) => document.getElementById(r.getAttribute('aria-labelledby')!)!);
    expect(targets.map((t) => t.tagName)).toEqual(['SPAN', 'SPAN', 'SPAN']);
    expect(targets.map((t) => t.textContent)).toEqual(['하나', '둘', '셋']);
  });

  it('⭐묶음에 접근성 이름이 있다(role=radiogroup + aria-label)', async () => {
    await render(<Three initial={null} onValue={() => {}} />);
    expect(container.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('순서');
  });

  it('⭐화살표 키는 다음 · 이전 항목을 고르고 끝에서 반대편으로 돈다(날것 radio와 같음)', async () => {
    const seen: string[] = [];
    await render(<Three initial="a" onValue={(v) => seen.push(v)} />);
    radios()[0]!.focus();
    await press(document.activeElement!, 'ArrowDown');
    await press(document.activeElement!, 'ArrowRight');
    await press(document.activeElement!, 'ArrowUp');
    expect(seen).toEqual(['b', 'c', 'b']);
    radios()[1]!.focus();
    await press(document.activeElement!, 'ArrowLeft');
    await press(document.activeElement!, 'ArrowLeft');
    expect(seen.slice(-2)).toEqual(['a', 'c']);
  });
});
