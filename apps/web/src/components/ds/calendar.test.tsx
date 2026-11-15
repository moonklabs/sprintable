// @vitest-environment jsdom
// UI-3(a9d56577) — ds Calendar 회귀가드: 7×6 격자 · 오늘(aria-current + 점) · 고른 날(aria-selected) · 범위 밖(aria-disabled, 숨기지 않음) ·
// 키보드(←→↑↓ · Home/End · PageUp/Down · Shift+Page) · roving 탭 순서 · 달 단추 · 범위 끝에서 멈춤 · 로케일 이름 · 주 시작.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Calendar, type CalendarProps } from './calendar';

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

const LABELS = { previousMonth: '이전 달', nextMonth: '다음 달' };
const base: CalendarProps = { value: null, onChange: () => {}, today: '2026-11-11', locale: 'ko', labels: LABELS };
const cell = (iso: string) => container.querySelector(`button[data-date="${iso}"]`) as HTMLButtonElement;
const cells = () => Array.from(container.querySelectorAll('button[data-date]')) as HTMLButtonElement[];
const title = () => container.querySelector('[data-slot="ds-calendar-title"]')!.textContent;
const tabbable = () => cells().filter((b) => b.tabIndex === 0).map((b) => b.dataset.date);
const key = async (target: Element, k: string, init: KeyboardEventInit = {}) => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); }); };
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);

describe('ds Calendar — 격자', () => {
  it('⭐7×6 = 42칸 · 첫 열 일요일 · 달 이름과 격자 이름 · 요일 머리글 7개', async () => {
    await render(<Calendar {...base} />);
    expect(cells().length).toBe(42);
    expect(cells()[0]!.dataset.date).toBe('2026-11-01');
    expect(title()).toBe('2026년 11월');
    expect(container.querySelector('table')!.getAttribute('aria-label')).toBe('2026년 11월');
    expect(container.querySelector('table')!.getAttribute('role')).toBe('grid');
    const heads = Array.from(container.querySelectorAll('th'));
    expect(heads.map((h) => h.textContent)).toEqual(['일', '월', '화', '수', '목', '금', '토']);
    expect(heads.map((h) => h.getAttribute('abbr'))).toEqual(['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']);
    expect(container.querySelectorAll('tbody tr').length).toBe(6);
  });

  it('주 시작을 월요일로 · 로케일 en이면 영어 이름 · 모르는 로케일은 en으로 떨어진다', async () => {
    await render(<Calendar {...base} weekStartsOn={1} locale="en" />);
    expect(cells()[0]!.dataset.date).toBe('2026-10-26');
    expect(Array.from(container.querySelectorAll('th')).map((h) => h.textContent)[0]).toBe('Mon');
    expect(title()).toBe('November 2026');
    await render(<Calendar {...base} locale="not-a-locale-@@" />);
    expect(title()).toBe('November 2026');
  });

  it('⭐날 칸은 날 전체 이름을 읽고 글자는 날짜 숫자다', async () => {
    await render(<Calendar {...base} />);
    expect(cell('2026-11-11').getAttribute('aria-label')).toBe('2026년 11월 11일 수요일');
    expect(cell('2026-11-11').textContent).toBe('11');
    expect(cell('2026-12-01').textContent).toBe('1');
  });

  it('⭐오늘 = aria-current="date" + 점 모양 · 고른 날 = 셀 aria-selected + 면 · 앞뒤 달의 날은 흐림', async () => {
    await render(<Calendar {...base} value="2026-11-20" />);
    expect(cell('2026-11-11').getAttribute('aria-current')).toBe('date');
    expect(has(cell('2026-11-11'), 'after:rounded-full')).toBe(true);
    expect(cell('2026-11-12').hasAttribute('aria-current')).toBe(false);
    expect(cell('2026-11-20').closest('td')!.getAttribute('aria-selected')).toBe('true');
    expect(cell('2026-11-21').closest('td')!.hasAttribute('aria-selected')).toBe(false);
    expect(has(cell('2026-11-20'), 'bg-ds-action')).toBe(true);
    expect(has(cell('2026-11-20'), 'text-ds-on-action')).toBe(true);
    expect(cell('2026-12-01').dataset.outside).toBe('true');
    expect(has(cell('2026-12-01'), 'text-ds-ink-3')).toBe(true);
    expect(cell('2026-11-15').dataset.outside).toBeUndefined();
  });

  it('고른 날이 오늘이면 점이 면 위 글자색', async () => {
    await render(<Calendar {...base} value="2026-11-11" />);
    expect(has(cell('2026-11-11'), 'after:bg-ds-on-action')).toBe(true);
    expect(has(cell('2026-11-11'), 'after:bg-ds-action')).toBe(false);
  });

  it('⭐높이 32 · 폰(touch)은 44 — 폰은 칸이 열 너비를 채운다', async () => {
    await render(<Calendar {...base} />);
    expect(has(cell('2026-11-11'), 'h-ds-compact')).toBe(true);
    expect(has(cell('2026-11-11'), 'touch:h-ds-touch')).toBe(true);
    expect(has(cell('2026-11-11'), 'touch:w-full')).toBe(true);
    expect(has(container.firstElementChild!, 'touch:w-72')).toBe(true);
  });
});

describe('ds Calendar — 고르기 · 범위', () => {
  it('⭐누르면 onChange(그 날) · 앞뒤 달의 날을 눌러도 고르고 보이는 달이 따라간다', async () => {
    const onChange = vi.fn();
    await render(<Calendar {...base} onChange={onChange} />);
    await act(async () => { cell('2026-11-20').click(); });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-20');
    await act(async () => { cell('2026-12-02').click(); });
    expect(onChange).toHaveBeenLastCalledWith('2026-12-02');
    expect(title()).toBe('2026년 12월');
  });

  it('⭐범위 밖은 숨기지 않고 aria-disabled · 눌러도 안 고른다 · 범위 안은 그대로', async () => {
    const onChange = vi.fn();
    await render(<Calendar {...base} onChange={onChange} min="2026-11-05" max="2026-11-25" />);
    expect(cells().length).toBe(42);
    expect(cell('2026-11-04').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-11-26').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-11-05').hasAttribute('aria-disabled')).toBe(false);
    expect(cell('2026-11-25').hasAttribute('aria-disabled')).toBe(false);
    expect(has(cell('2026-11-04'), 'line-through')).toBe(true);
    await act(async () => { cell('2026-11-04').click(); });
    await act(async () => { cell('2026-11-26').click(); });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => { cell('2026-11-05').click(); });
    expect(onChange).toHaveBeenCalledWith('2026-11-05');
  });

  it('값이 없으면 오늘이 · 오늘이 범위 밖이면 가까운 범위 끝이 보이는 달 · 값이 틀린 글이면 오늘', async () => {
    await render(<Calendar key="a" {...base} min="2027-02-10" />);
    expect(title()).toBe('2027년 2월');
    expect(tabbable()).toEqual(['2027-02-10']);
    await render(<Calendar key="b" {...base} value="not-a-date" />);
    expect(tabbable()).toEqual(['2026-11-11']);
    // 값을 비워도(null) 직전에 보던 달에 머문다 — 달력이 갑자기 오늘로 튀지 않는다
    await render(<Calendar key="c" {...base} value="2026-11-20" />);
    await render(<Calendar key="c" {...base} value={null} />);
    expect(tabbable()).toEqual(['2026-11-20']);
  });

  it('⭐범위가 바뀌어 초점 날이 범위 밖이 되면 가까운 끝으로 맞춘다', async () => {
    await render(<Calendar key="r" {...base} value="2026-11-20" />);
    await render(<Calendar key="r" {...base} value="2026-11-20" min="2026-12-01" />);
    expect(tabbable()).toEqual(['2026-12-01']);
    await render(<Calendar key="r" {...base} value="2026-11-20" min="2026-12-01" max="2026-12-05" />);
    expect(tabbable()).toEqual(['2026-12-01']);
  });

  it('⭐밖에서 value가 바뀌면 보이는 달 · 초점 날이 따라간다', async () => {
    await render(<Calendar {...base} value="2026-11-20" />);
    await render(<Calendar {...base} value="2027-03-04" />);
    expect(title()).toBe('2027년 3월');
    expect(tabbable()).toEqual(['2027-03-04']);
  });
});

describe('ds Calendar — 키보드', () => {
  it('⭐roving: 탭 순서에 든 칸은 하나(초점 날) — 값이 있으면 그 날, 없으면 오늘', async () => {
    await render(<Calendar key="a" {...base} value="2026-11-20" />);
    expect(tabbable()).toEqual(['2026-11-20']);
    await render(<Calendar key="b" {...base} value={null} />);
    expect(tabbable()).toEqual(['2026-11-11']);
  });

  it('⭐←→ 하루 · ↑↓ 한 주 — 실제 초점도 따라간다', async () => {
    await render(<Calendar {...base} value="2026-11-11" />);
    cell('2026-11-11').focus();
    await key(cell('2026-11-11'), 'ArrowRight');
    expect(document.activeElement).toBe(cell('2026-11-12'));
    expect(tabbable()).toEqual(['2026-11-12']);
    await key(document.activeElement!, 'ArrowLeft');
    await key(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement).toBe(cell('2026-11-10'));
    await key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(cell('2026-11-17'));
    await key(document.activeElement!, 'ArrowUp');
    await key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(cell('2026-11-03'));
  });

  it('⭐달 끝을 넘으면 보이는 달이 바뀐다(←: 11-01 → 10-31 · →: 11-30 → 12-01)', async () => {
    await render(<Calendar {...base} value="2026-11-01" />);
    cell('2026-11-01').focus();
    await key(cell('2026-11-01'), 'ArrowLeft');
    expect(title()).toBe('2026년 10월');
    expect(document.activeElement).toBe(cell('2026-10-31'));
    await render(<Calendar {...base} value="2026-11-30" />);
    cell('2026-11-30').focus();
    await key(cell('2026-11-30'), 'ArrowRight');
    expect(title()).toBe('2026년 12월');
    expect(document.activeElement).toBe(cell('2026-12-01'));
  });

  it('⭐Home/End = 주의 처음/끝 · PageUp/PageDown = 한 달(달 끝 날은 그 달 마지막 날로) · Shift = 한 해', async () => {
    await render(<Calendar {...base} value="2026-11-11" />);
    cell('2026-11-11').focus();
    await key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(cell('2026-11-08'));
    await key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(cell('2026-11-14'));
    await key(document.activeElement!, 'PageDown');
    expect(title()).toBe('2026년 12월');
    expect(document.activeElement).toBe(cell('2026-12-14'));
    await key(document.activeElement!, 'PageUp', { shiftKey: true });
    expect(title()).toBe('2025년 12월');
    expect(document.activeElement).toBe(cell('2025-12-14'));
    await render(<Calendar {...base} value="2026-01-31" />);
    cell('2026-01-31').focus();
    await key(document.activeElement!, 'PageDown');
    expect(document.activeElement).toBe(cell('2026-02-28'));
    // Shift+PageDown = 한 해 뒤(PageUp과 대칭)
    await render(<Calendar key="shift" {...base} value="2026-11-11" />);
    cell('2026-11-11').focus();
    await key(document.activeElement!, 'PageDown', { shiftKey: true });
    expect(title()).toBe('2027년 11월');
    expect(document.activeElement).toBe(cell('2027-11-11'));
  });

  it('⭐범위 끝에서 멈춘다 — 화살표가 범위 밖 칸에 서지 않는다', async () => {
    await render(<Calendar {...base} value="2026-11-25" min="2026-11-05" max="2026-11-25" />);
    cell('2026-11-25').focus();
    await key(document.activeElement!, 'ArrowRight');
    expect(document.activeElement).toBe(cell('2026-11-25'));
    await key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(cell('2026-11-25'));
    await key(document.activeElement!, 'PageDown');
    expect(document.activeElement).toBe(cell('2026-11-25'));
    await key(document.activeElement!, 'PageUp');
    expect(document.activeElement).toBe(cell('2026-10-25'.replace('10-25', '11-05'))); // 한 달 앞이 범위 밖이면 범위 처음으로
  });

  it('다른 키 · 수정키 조합은 가로채지 않는다(Enter · Space는 단추 몫, Esc는 팝오버 몫)', async () => {
    await render(<Calendar {...base} value="2026-11-11" />);
    cell('2026-11-11').focus();
    for (const [k, init] of [['Enter', {}], [' ', {}], ['Escape', {}], ['a', {}], ['ArrowRight', { ctrlKey: true }], ['ArrowRight', { altKey: true }], ['ArrowRight', { metaKey: true }]] as const) {
      const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
      await act(async () => { cell('2026-11-11').dispatchEvent(ev); });
      expect(ev.defaultPrevented, `${k} ${JSON.stringify(init)}`).toBe(false);
    }
    expect(tabbable()).toEqual(['2026-11-11']);
  });
});

describe('ds Calendar — 초점 · 방향 · 범위 끝', () => {
  it('⭐격자 안에 초점이 있는데 밖에서 값이 바뀌어 그 칸이 사라지면 새 초점 칸으로 초점이 간다(문서로 떨어지지 않는다)', async () => {
    await render(<Calendar key="f" {...base} value="2026-11-20" />);
    cell('2026-11-20').focus();
    expect(document.activeElement).toBe(cell('2026-11-20'));
    await render(<Calendar key="f" {...base} value="2027-03-04" />);
    expect(title()).toBe('2027년 3월');
    expect(document.activeElement).toBe(cell('2027-03-04'));
  });

  it('⭐같은 달 안에서 밖의 value가 바뀌면 실제 초점도 새 칸으로 간다 — 탭 순서 칸과 초점이 갈리지 않아 다음 →가 엉뚱한 칸으로 튀지 않는다', async () => {
    await render(<Calendar key="s" {...base} value="2026-11-10" />);
    cell('2026-11-10').focus();
    await render(<Calendar key="s" {...base} value="2026-11-20" />);
    expect(tabbable()).toEqual(['2026-11-20']);
    expect(document.activeElement).toBe(cell('2026-11-20'));
    await key(cell('2026-11-20'), 'ArrowRight');
    expect(document.activeElement).toBe(cell('2026-11-21'));
  });

  it('⭐달 단추를 (초점을 못 받는 채로) 눌러 달이 바뀌어도 초점이 격자 칸으로 튀지 않는다 — 밖의 값 변경만 초점을 옮긴다', async () => {
    await render(<Calendar key="m" {...base} value="2026-11-20" />);
    cell('2026-11-20').focus();
    await act(async () => { (container.querySelector('button[aria-label="다음 달"]') as HTMLButtonElement).click(); });
    expect(title()).toBe('2026년 12월');
    expect(tabbable()).toEqual(['2026-12-20']);
    expect(document.activeElement).not.toBe(cell('2026-12-20'));
    // 그 뒤에 밖에서 값이 바뀌는 것은 여전히 초점을 따라 옮긴다.
    cell('2026-12-20').focus();
    await render(<Calendar key="m" {...base} value="2026-12-25" />);
    expect(document.activeElement).toBe(cell('2026-12-25'));
  });

  it('같은 달 안에서 value가 바뀌어도 격자 밖에 있던 초점은 빼앗지 않는다', async () => {
    await render(<><button type="button" id="other2">다른 곳</button><Calendar key="t" {...base} value="2026-11-10" /></>);
    (document.getElementById('other2') as HTMLButtonElement).focus();
    await render(<><button type="button" id="other2">다른 곳</button><Calendar key="t" {...base} value="2026-11-20" /></>);
    expect(document.activeElement).toBe(document.getElementById('other2'));
  });

  it('⭐초점이 격자에 들어갔다가 밖으로 나갔다면(다른 단추로) 값이 바뀌어도 초점을 빼앗지 않는다', async () => {
    await render(<><button type="button" id="other">다른 곳</button><Calendar key="g" {...base} value="2026-11-20" /></>);
    cell('2026-11-20').focus();
    (document.getElementById('other') as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(document.getElementById('other'));
    await render(<><button type="button" id="other">다른 곳</button><Calendar key="g" {...base} value="2027-03-04" /></>);
    expect(title()).toBe('2027년 3월');
    expect(document.activeElement).toBe(document.getElementById('other'));
  });

  it('초점이 격자에 한 번도 없었다면 값이 바뀌어도 초점을 빼앗지 않는다', async () => {
    await render(<><button type="button" id="other">다른 곳</button><Calendar key="h" {...base} value="2026-11-20" /></>);
    (document.getElementById('other') as HTMLButtonElement).focus();
    await render(<><button type="button" id="other">다른 곳</button><Calendar key="h" {...base} value="2027-03-04" /></>);
    expect(document.activeElement).toBe(document.getElementById('other'));
  });

  it('⭐오른쪽→왼쪽 글(dir=rtl)에서는 ←가 다음 날 · →가 앞 날', async () => {
    await render(<div dir="rtl"><Calendar {...base} value="2026-11-11" /></div>);
    cell('2026-11-11').focus();
    await key(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement).toBe(cell('2026-11-12'));
    await key(document.activeElement!, 'ArrowRight');
    await key(document.activeElement!, 'ArrowRight');
    expect(document.activeElement).toBe(cell('2026-11-10'));
  });

  it('⭐0001-01: 앞 칸은 빈 칸(날짜 없음) · 요일 머리글은 그대로 일~토 · 1일은 월요일 칸', async () => {
    await render(<Calendar {...base} value="0001-01-15" today="0001-01-15" />);
    expect(cells().length).toBeLessThan(42); // 빈 칸은 단추가 아니다
    expect(Array.from(container.querySelectorAll('th')).map((h) => h.textContent)).toEqual(['일', '월', '화', '수', '목', '금', '토']);
    expect(cells()[0]!.dataset.date).toBe('0001-01-01');
    const firstRowCells = container.querySelectorAll('tbody tr')[0]!.querySelectorAll('td');
    expect(firstRowCells[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(firstRowCells[1]!.querySelector('button')!.dataset.date).toBe('0001-01-01');
    const dates = cells().map((b) => b.dataset.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('⭐9999-12: 뒤 칸은 빈 칸 · 같은 날이 두 번 그려지지 않는다', async () => {
    await render(<Calendar {...base} value="9999-12-20" today="9999-12-20" />);
    const dates = cells().map((b) => b.dataset.date);
    expect(dates).toContain('9999-12-31');
    expect(new Set(dates).size).toBe(dates.length);
    expect(container.querySelectorAll('td[aria-hidden="true"]').length).toBeGreaterThan(0);
  });
});

describe('ds Calendar — 달 단추', () => {
  it('⭐표현 범위의 끝(0001-01 · 9999-12)에서는 min · max가 없어도 그 방향 단추가 잠긴다 — 눌러도 아무 일 없는 단추를 켜 두지 않는다', async () => {
    const btn = (name: string) => container.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;
    await render(<Calendar key="b1" {...base} value="0001-01-15" today="0001-01-15" />);
    expect(btn('이전 달').disabled).toBe(true);
    expect(btn('다음 달').disabled).toBe(false);
    await render(<Calendar key="b2" {...base} value="9999-12-20" today="9999-12-20" />);
    expect(btn('이전 달').disabled).toBe(false);
    expect(btn('다음 달').disabled).toBe(true);
    await render(<Calendar key="b3" {...base} value="0001-02-01" today="0001-02-01" />);
    expect(btn('이전 달').disabled).toBe(false);
    await render(<Calendar key="b4" {...base} value="9999-11-30" today="9999-11-30" />);
    expect(btn('다음 달').disabled).toBe(false);
  });

  it('⭐‹ › 단추는 이름이 있고 달을 넘긴다 — 초점은 단추에 그대로(훔치지 않는다)', async () => {
    await render(<Calendar {...base} value="2026-11-11" />);
    const prev = container.querySelector('button[aria-label="이전 달"]') as HTMLButtonElement;
    const next = container.querySelector('button[aria-label="다음 달"]') as HTMLButtonElement;
    prev.focus();
    await act(async () => { prev.click(); });
    expect(title()).toBe('2026년 10월');
    expect(document.activeElement).toBe(prev);
    await act(async () => { next.click(); next.click(); });
    expect(title()).toBe('2026년 12월');
    // › 단추도 초점을 훔치지 않는다(키보드로 달을 넘기며 단추에 머문다)
    next.focus();
    await act(async () => { next.click(); });
    expect(title()).toBe('2027년 1월');
    expect(document.activeElement).toBe(next);
  });

  it('⭐범위 끝 달에서는 그 방향 단추가 잠긴다', async () => {
    await render(<Calendar {...base} value="2026-11-11" min="2026-11-03" max="2026-11-28" />);
    const prev = container.querySelector('button[aria-label="이전 달"]') as HTMLButtonElement;
    const next = container.querySelector('button[aria-label="다음 달"]') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    await render(<Calendar {...base} value="2026-11-11" min="2026-10-31" max="2026-12-01" />);
    expect((container.querySelector('button[aria-label="이전 달"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('button[aria-label="다음 달"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('달 이름은 aria-live(달이 바뀌면 읽힌다)', async () => {
    await render(<Calendar {...base} />);
    expect(container.querySelector('[data-slot="ds-calendar-title"]')!.getAttribute('aria-live')).toBe('polite');
  });
});
