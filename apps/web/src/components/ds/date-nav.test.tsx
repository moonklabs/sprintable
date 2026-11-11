// @vitest-environment jsdom
// UI-3(a9d56577) — ds DateNav 회귀가드: 날짜 옮기기(달 · 해 · 윤일 경계) · 이름 있는 화살표 · 모르는 날은 잠금 · 오늘 · 날짜 칸 입력 · 어두운 화면의 달력 아이콘.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DateNav, shiftDate } from './date-nav';

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
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }

const labels = { date: '날짜', previousDay: '전날', nextDay: '다음날', today: '오늘' };
const input = () => container.querySelector('input[type="date"]') as HTMLInputElement;
const btn = (name: string) => [...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name) as HTMLButtonElement;

describe('shiftDate', () => {
  it('⭐달 · 해 · 윤일 경계를 넘어 옮긴다', () => {
    expect(shiftDate('2026-11-10', 1)).toBe('2026-11-11');
    expect(shiftDate('2026-11-30', 1)).toBe('2026-12-01');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDate('2027-02-28', 1)).toBe('2027-03-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('⭐달력의 끝(0001-01-01 앞 · 9999-12-31 뒤)에서는 옮기지 않는다 — 칸이 못 받는 값을 만들지 않는다', () => {
    expect(shiftDate('0001-01-01', -1)).toBe('0001-01-01');
    expect(shiftDate('9999-12-31', 1)).toBe('9999-12-31');
    expect(shiftDate('0001-01-01', 1)).toBe('0001-01-02');
    expect(shiftDate('9999-12-31', -1)).toBe('9999-12-30');
  });
  it('⭐0~99년도 1900년대로 바뀌지 않는다(Date.UTC 함정)', () => {
    expect(shiftDate('0001-01-02', -1)).toBe('0001-01-01');
    expect(shiftDate('0099-12-31', 1)).toBe('0100-01-01');
    expect(shiftDate('0050-03-01', -1)).toBe('0050-02-28');
  });
  it('형식이 아니면 그대로(NaN을 만들지 않는다)', () => {
    expect(shiftDate('', 1)).toBe('');
    expect(shiftDate('내일', -1)).toBe('내일');
  });
});

describe('ds DateNav', () => {
  it('⭐화살표는 이름이 있고(aria-label) 날짜 칸에도 이름이 있다', async () => {
    await render(<DateNav value="2026-11-10" onChange={() => {}} onToday={() => {}} labels={labels} />);
    expect(btn('전날').getAttribute('aria-label')).toBe('전날');
    expect(btn('다음날').getAttribute('aria-label')).toBe('다음날');
    expect(input().getAttribute('aria-label')).toBe('날짜');
    expect(input().value).toBe('2026-11-10');
  });

  it('← → 를 누르면 하루 옮긴 날짜로 onChange', async () => {
    const onChange = vi.fn();
    await render(<DateNav value="2026-11-30" onChange={onChange} onToday={() => {}} labels={labels} />);
    await act(async () => { btn('다음날').click(); });
    await act(async () => { btn('전날').click(); });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['2026-12-01', '2026-11-29']);
  });

  it('⭐날짜를 아직 모르면(null) 칸 · 화살표가 잠기고 아무것도 안 부른다 — 오늘 단추는 살아 있다', async () => {
    const onChange = vi.fn(); const onToday = vi.fn();
    await render(<DateNav value={null} onChange={onChange} onToday={onToday} labels={labels} />);
    expect(btn('전날').disabled && btn('다음날').disabled && input().disabled).toBe(true);
    expect(input().value).toBe('');
    await act(async () => { btn('전날').click(); btn('다음날').click(); });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => { btn('오늘').click(); });
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it('⭐날짜 칸에서 고르면 onChange · 비우면 빈 글도 그대로 알린다(호출부가 «모름»으로 돌아감)', async () => {
    const onChange = vi.fn();
    await render(<DateNav value="2026-11-10" onChange={onChange} onToday={() => {}} labels={labels} />);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { set.call(input(), '2026-12-25'); input().dispatchEvent(new Event('input', { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('2026-12-25');
    await act(async () => { set.call(input(), ''); input().dispatchEvent(new Event('input', { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('⭐빈 글(\'\')도 «아직 모름»이다 — 칸 · 화살표가 잠기고 아무것도 안 부른다(스탠드업이 모름을 빈 글로 든다)', async () => {
    const onChange = vi.fn();
    await render(<DateNav value="" onChange={onChange} onToday={() => {}} labels={labels} />);
    expect(btn('전날').disabled && btn('다음날').disabled && input().disabled).toBe(true);
    await act(async () => { btn('전날').click(); btn('다음날').click(); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('⭐min · max · step이 칸에 넘어가고 화살표는 그 밖으로 못 간다', async () => {
    const onChange = vi.fn();
    await render(<DateNav value="2026-11-10" min="2026-11-10" max="2026-11-12" step={1} onChange={onChange} onToday={() => {}} labels={labels} />);
    expect(input().min).toBe('2026-11-10');
    expect(input().max).toBe('2026-11-12');
    expect(input().step).toBe('1');
    expect(btn('전날').disabled).toBe(true);
    expect(btn('다음날').disabled).toBe(false);
    await render(<DateNav value="2026-11-12" min="2026-11-10" max="2026-11-12" onChange={onChange} onToday={() => {}} labels={labels} />);
    expect(btn('다음날').disabled).toBe(true);
    expect(btn('전날').disabled).toBe(false);
  });

  it('⭐달력의 끝에서는 그 쪽 화살표가 잠긴다(0001-01-01의 전날 · 9999-12-31의 다음날)', async () => {
    await render(<DateNav value="0001-01-01" onChange={() => {}} onToday={() => {}} labels={labels} />);
    expect(btn('전날').disabled).toBe(true);
    expect(btn('다음날').disabled).toBe(false);
    await render(<DateNav value="9999-12-31" onChange={() => {}} onToday={() => {}} labels={labels} />);
    expect(btn('다음날').disabled).toBe(true);
    expect(btn('전날').disabled).toBe(false);
  });

  it('⭐줄은 좁은 화면에서 접히고(flex-wrap) 날짜 칸도 폰 누름 높이 44를 지킨다', async () => {
    await render(<DateNav value="2026-11-10" onChange={() => {}} onToday={() => {}} labels={labels} />);
    expect((container.querySelector('[data-slot="ds-date-nav"]') as HTMLElement).className).toContain('flex-wrap');
    expect(input().className).toContain('pointer-coarse:h-11');
  });

  it('⭐날짜 칸은 어두운 화면에서 달력 아이콘이 보이게 color-scheme을 알린다 · 폭은 내용만큼', async () => {
    await render(<DateNav value="2026-11-10" onChange={() => {}} onToday={() => {}} labels={labels} />);
    expect(input().className).toContain('[color-scheme:light]');
    expect(input().className).toContain('dark:[color-scheme:dark]');
    expect(input().className).toContain('w-auto');
    expect(input().className).toMatch(/(^|\s)text-base(\s|$)/);
  });
});
