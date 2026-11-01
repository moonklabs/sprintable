// @vitest-environment jsdom
//
// story 4831 부품 교체 — «겉모습만 바탕으로 옮기고 동작은 그대로»를 바탕 부품 단위로 못박는다(PO 조건, 2026-11-02).
// 날것 <select> · <textarea>는 네이티브 그대로여야 한다(폼 제출 · 검증 · onChange의 네이티브 이벤트 · ref · disabled).
// 날것 checkbox · radio를 Checkbox · RadioGroup으로 바꿀 때 사람이 보는 동작(라벨을 눌러도 켜진다 · 한 묶음에서 하나만 · 상태 표시)이 그대로여야 한다.
// 이 시험이 빨개지면 화면 쪽 교체 PR들이 기대는 부품의 동작이 바뀐 것이다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Textarea } from './textarea';
import { Select } from './select';
import { Checkbox } from './checkbox';
import { RadioGroup, RadioGroupItem } from './radio-group';

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

async function render(ui: React.ReactNode): Promise<void> {
  await act(async () => { root.render(ui); });
}

describe('Select — 네이티브 <select> 그대로', () => {
  it('실제 <select>이고 <option> 자식을 그대로 받는다', async () => {
    await render(<Select aria-label="s"><option value="a">가</option><option value="b">나</option></Select>);
    const el = container.querySelector('select')!;
    expect(el).toBeTruthy();
    expect([...el.options].map((o) => o.value)).toEqual(['a', 'b']);
  });

  it('고르면 네이티브 change 이벤트가 오고 e.target.value가 읽힌다', async () => {
    const seen: string[] = [];
    await render(
      <Select aria-label="s" defaultValue="a" onChange={(e) => seen.push(e.target.value)}>
        <option value="a">가</option><option value="b">나</option>
      </Select>,
    );
    const el = container.querySelector('select')!;
    await act(async () => {
      el.value = 'b';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seen).toEqual(['b']);
  });

  it('폼 제출 값에 name=value로 실린다', async () => {
    await render(
      <form>
        <Select aria-label="s" name="k" defaultValue="b"><option value="a">가</option><option value="b">나</option></Select>
      </form>,
    );
    const data = new FormData(container.querySelector('form')!);
    expect(data.get('k')).toBe('b');
  });

  it('required는 비었을 때 검증을 막고 고르면 통과한다(네이티브 검증)', async () => {
    await render(
      <Select aria-label="s" required defaultValue=""><option value="">고르세요</option><option value="a">가</option></Select>,
    );
    const el = container.querySelector('select')!;
    expect(el.checkValidity()).toBe(false);
    await act(async () => { el.value = 'a'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(el.checkValidity()).toBe(true);
  });

  it('disabled를 지키고, ref가 실제 <select>에 닿는다', async () => {
    const ref = { current: null as HTMLSelectElement | null };
    await render(<Select aria-label="s" disabled ref={ref}><option value="a">가</option></Select>);
    expect(container.querySelector('select')!.disabled).toBe(true);
    expect(ref.current).toBe(container.querySelector('select'));
  });
});

describe('Textarea — 네이티브 <textarea> 그대로', () => {
  it('입력하면 부르는 쪽의 onChange가 네이티브 이벤트로 불리고(e.target.value), 제어 상태가 그 값으로 바뀐다', async () => {
    const seen: string[] = [];
    function Controlled() {
      const [v, setV] = useState('');
      return (
        <>
          <Textarea aria-label="t" value={v} onChange={(e) => { seen.push(e.target.value); setV(e.target.value); }} />
          <output data-testid="mirror">{v}</output>
        </>
      );
    }
    await render(<Controlled />);
    const el = container.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(el, '안녕');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen).toEqual(['안녕']);
    expect(container.querySelector('[data-testid="mirror"]')!.textContent).toBe('안녕');
    expect(el.value).toBe('안녕');
  });

  it('폼 제출 값 · required 검증 · maxLength · rows · placeholder가 그대로다', async () => {
    await render(
      <form>
        <Textarea aria-label="t" name="why" required rows={3} maxLength={5} placeholder="사유" defaultValue="" />
      </form>,
    );
    const el = container.querySelector('textarea')!;
    expect(el.rows).toBe(3);
    expect(el.maxLength).toBe(5);
    expect(el.placeholder).toBe('사유');
    expect(el.checkValidity()).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(el, '이유');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(el.checkValidity()).toBe(true);
    expect(new FormData(container.querySelector('form')!).get('why')).toBe('이유');
  });

  it('ref · id · disabled가 실제 <textarea>에 닿는다(라벨 htmlFor 연결 포함)', async () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    await render(
      <>
        <label htmlFor="why-x">사유</label>
        <Textarea id="why-x" ref={ref} disabled />
      </>,
    );
    const el = container.querySelector('textarea')!;
    expect(ref.current).toBe(el);
    expect(el.disabled).toBe(true);
    expect(container.querySelector('label')!.htmlFor).toBe(el.id);
  });
});

describe('Checkbox — 사람이 보는 동작', () => {
  it('role=checkbox이고 켜짐 상태가 aria-checked로 드러난다', async () => {
    await render(<Checkbox aria-label="c" checked onCheckedChange={() => {}} />);
    const el = container.querySelector('[role="checkbox"]')!;
    expect(el.getAttribute('aria-checked')).toBe('true');
  });

  it('감싼 라벨의 글자를 눌러도 켜진다(날것 checkbox와 같은 동작)', async () => {
    const onChange = vi.fn();
    function Wrapped() {
      const [on, setOn] = useState(false);
      return (
        <label data-testid="l"><Checkbox checked={on} onCheckedChange={(v) => { setOn(v); onChange(v); }} /><span data-testid="txt">확인했어요</span></label>
      );
    }
    await render(<Wrapped />);
    await act(async () => { (container.querySelector('[data-testid="txt"]') as HTMLElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(container.querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('true');
    await act(async () => { (container.querySelector('[data-testid="txt"]') as HTMLElement).click(); });
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('data-testid · disabled를 뿌리 요소에 그대로 둔다(시험 · 접근성 손잡이)', async () => {
    await render(<Checkbox data-testid="x" disabled checked={false} onCheckedChange={() => {}} />);
    const el = container.querySelector('[data-testid="x"]') as HTMLElement;
    expect(el.getAttribute('role')).toBe('checkbox');
    expect(el.hasAttribute('data-disabled') || el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('RadioGroup — 사람이 보는 동작', () => {
  function Group({ onValue }: { onValue: (v: string) => void }) {
    const [v, setV] = useState('');
    return (
      <RadioGroup name="opt" value={v} onValueChange={(next) => { setV(String(next)); onValue(String(next)); }}>
        <label data-testid="la"><RadioGroupItem value="a" /><span data-testid="ta">가</span></label>
        <label data-testid="lb"><RadioGroupItem value="b" /><span data-testid="tb">나</span></label>
      </RadioGroup>
    );
  }

  it('role=radiogroup 안에 role=radio 둘이 있고 처음엔 아무것도 켜져 있지 않다', async () => {
    await render(<Group onValue={() => {}} />);
    expect(container.querySelector('[role="radiogroup"]')).toBeTruthy();
    const radios = [...container.querySelectorAll('[role="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false']);
  });

  it('값이 null이면 «선택 없음» — 값이 빈 문자열인 선택지가 있어도 처음부터 켜져 있지 않다(날것 radio와 같음)', async () => {
    await render(
      <RadioGroup name="opt" value={null} onValueChange={() => {}}>
        <label><RadioGroupItem value="" /><span>빈 선택지</span></label>
        <label><RadioGroupItem value="b" /><span>나</span></label>
      </RadioGroup>,
    );
    expect([...container.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false']);
  });

  it('빈 문자열 선택지도 눌러서 고를 수 있고, 고르면 그것만 켜진다', async () => {
    const seen: string[] = [];
    function Group() {
      const [v, setV] = useState<string | null>(null);
      return (
        <RadioGroup name="opt" value={v} onValueChange={(next) => { setV(String(next)); seen.push(String(next)); }}>
          <label><RadioGroupItem value="" /><span data-testid="empty">빈 선택지</span></label>
          <label><RadioGroupItem value="b" /><span>나</span></label>
        </RadioGroup>
      );
    }
    await render(<Group />);
    await act(async () => { (container.querySelector('[data-testid="empty"]') as HTMLElement).click(); });
    expect(seen).toEqual(['']);
    expect([...container.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('라벨 글자를 누르면 그 항목만 켜지고 다른 항목은 꺼진다(한 묶음에서 하나)', async () => {
    const seen: string[] = [];
    await render(<Group onValue={(v) => seen.push(v)} />);
    await act(async () => { (container.querySelector('[data-testid="ta"]') as HTMLElement).click(); });
    expect([...container.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await act(async () => { (container.querySelector('[data-testid="tb"]') as HTMLElement).click(); });
    expect([...container.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(seen).toEqual(['a', 'b']);
  });
});
