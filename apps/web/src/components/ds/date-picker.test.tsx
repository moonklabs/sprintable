// @vitest-environment jsdom
// UI-3(a9d56577) — ds DatePicker 회귀가드: 트리거 이름 · 값 글(로케일) · 자리표시 · 열면 달력 · 고르면 알리고 닫기 · 비활성 · 오류 · 폰 높이.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DatePicker, type DatePickerProps } from './date-picker';

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

const LABELS = { date: '시작일', placeholder: '날짜 고르기', previousMonth: '이전 달', nextMonth: '다음 달' };
const base: DatePickerProps = { value: null, onChange: () => {}, today: '2026-11-11', locale: 'ko', labels: LABELS };
const trigger = () => container.querySelector('[data-slot="ds-date-picker"]') as HTMLButtonElement;
const popup = () => document.querySelector('[data-slot="ds-date-picker-popup"]') as HTMLElement | null;
const dayButton = (iso: string) => document.querySelector(`button[data-date="${iso}"]`) as HTMLButtonElement | null;
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);
const open = async () => { await act(async () => { trigger().click(); }); };

describe('ds DatePicker', () => {
  it('⭐트리거는 이름(aria-label)이 있는 단추다 — 값이 없으면 자리표시 글 + 달력 아이콘', async () => {
    await render(<DatePicker {...base} />);
    expect(trigger().tagName).toBe('BUTTON');
    // 이름은 aria-label이 아니라 «보이지 않는 글 + 보이는 값» — aria-label이면 고른 날이 읽히지 않는다.
    expect(trigger().hasAttribute('aria-label')).toBe(false);
    expect(trigger().querySelector('.sr-only')!.textContent).toBe('시작일 ');
    expect(trigger().textContent).toBe('시작일 날짜 고르기');
    expect(trigger().querySelector('[data-icon="calendar_month"]')).not.toBeNull();
    expect(popup()).toBeNull();
  });

  it('⭐값이 있으면 로케일 날짜 글(ko: «2026. 11. 20.» 꼴) — 틀린 값이면 자리표시로', async () => {
    await render(<DatePicker {...base} value="2026-11-20" />);
    expect(trigger().textContent).toContain('2026');
    expect(trigger().textContent).toContain('20');
    expect(trigger().textContent).not.toContain('날짜 고르기');
    // 이름과 값이 함께 읽힌다
    expect(trigger().textContent).toMatch(/^시작일 .*2026/);
    await render(<DatePicker {...base} value="not-a-date" />);
    expect(trigger().textContent).toBe('시작일 날짜 고르기');
    await render(<DatePicker {...base} value="2026-11-20" locale="en" />);
    expect(trigger().textContent).toContain('Nov 20, 2026');
  });

  it('⭐누르면 달력이 팝업으로 열리고(이름 = 트리거와 같다) 고른 날이 표시된다', async () => {
    await render(<DatePicker {...base} value="2026-11-20" />);
    await open();
    expect(popup()).not.toBeNull();
    expect(popup()!.getAttribute('aria-label')).toBe('시작일');
    expect(popup()!.querySelector('[data-slot="ds-calendar"]')).not.toBeNull();
    expect(dayButton('2026-11-20')!.closest('td')!.getAttribute('aria-selected')).toBe('true');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('⭐열면 초점이 «이전 달» 단추가 아니라 날짜 격자의 초점 칸으로 간다(방향키가 바로 먹는다)', async () => {
    await render(<DatePicker {...base} value="2026-11-20" />);
    await open();
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(document.activeElement).toBe(dayButton('2026-11-20'));
    expect(document.activeElement!.getAttribute('aria-label')).not.toBe('이전 달');
  });

  it('⭐날을 고르면 onChange(그 날) 한 번 · 팝업이 닫힌다', async () => {
    const onChange = vi.fn();
    await render(<DatePicker {...base} onChange={onChange} />);
    await open();
    await act(async () => { dayButton('2026-11-15')!.click(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-11-15');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('⭐범위 밖의 날을 눌러도 안 고르고 팝업도 안 닫힌다(min · max 전달)', async () => {
    const onChange = vi.fn();
    await render(<DatePicker {...base} onChange={onChange} min="2026-11-05" max="2026-11-25" />);
    await open();
    await act(async () => { dayButton('2026-11-04')!.click(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('달 단추 이름이 달력에 전달된다 · 주 시작(weekStartsOn)도', async () => {
    await render(<DatePicker {...base} weekStartsOn={1} />);
    await open();
    expect(document.querySelector('button[aria-label="이전 달"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="다음 달"]')).not.toBeNull();
    expect(document.querySelector('button[data-date]')!.getAttribute('data-date')).toBe('2026-10-26');
  });

  it('⭐비활성이면 열리지 않는다 · 오류면 aria-invalid', async () => {
    await render(<DatePicker {...base} disabled />);
    expect(trigger().disabled).toBe(true);
    await open();
    expect(popup()).toBeNull();
    await render(<DatePicker {...base} invalid />);
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    expect(has(trigger(), 'aria-invalid:border-ds-failed')).toBe(true);
  });

  it('칸 모양: 높이 36 · 폰 44 · Input과 같은 경계 · 초점 · 글자 16px(폰) / 13(lg)', async () => {
    await render(<DatePicker {...base} className="w-48" />);
    for (const c of ['h-9', 'touch:h-11', 'border-ds-line-control', 'bg-ds-surface-sunk', 'focus-visible:ring-ds-action', 'text-base', 'lg:text-ds-body', 'w-48']) expect(has(trigger(), c), c).toBe(true);
  });
});
