// @vitest-environment jsdom
// UI-3(a9d56577) — ds Stepper 회귀가드: 끝(체크) · 지금(링 + 번호 + aria-current=step) · 아직(속 빈 점 + 번호) · 상태 글(스크린리더) · 이은 선 색 · 같은 폭 · 범위 밖 current · 이름 필수.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Stepper } from './stepper';

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
const list = () => container.querySelector('[data-slot="ds-stepper"]') as HTMLElement;
const steps = () => Array.from(container.querySelectorAll('[data-slot="ds-stepper-step"]')) as HTMLElement[];
const dot = (i: number) => steps()[i].querySelector('[data-slot="ds-stepper-dot"]') as HTMLElement;
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);

const STEPS = [
  { id: 'role', label: '직무' },
  { id: 'scope', label: '스코프' },
  { id: 'runtime', label: '실행환경' },
  { id: 'bundle', label: '번들' },
  { id: 'verify', label: '검증' },
] as const;
const LABELS = { done: '끝남', current: '진행 중', upcoming: '대기' };

describe('ds Stepper', () => {
  it('⭐ol 목록 + 이름 필수(aria-label) + 단계 수만큼 li', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={2} stateLabels={LABELS} />);
    expect(list().tagName).toBe('OL');
    expect(list().getAttribute('aria-label')).toBe('채용 단계');
    expect(steps().length).toBe(5);
    expect(steps().map((s) => s.querySelector('[data-slot="ds-stepper-label"]')!.lastChild!.textContent)).toEqual(['직무', '스코프', '실행환경', '번들', '검증']);
  });

  it('⭐상태 셋: 앞은 끝(체크, 번호 없음) · 지금은 링 + 번호 · 뒤는 속 빈 점 + 번호', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={2} stateLabels={LABELS} />);
    expect(steps().map((s) => s.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    // 끝: done 테두리 + 체크 아이콘(번호 대신)
    expect(has(dot(0), 'border-ds-done')).toBe(true);
    expect(dot(0).querySelector('[data-icon="check"]')).not.toBeNull();
    expect(dot(0).textContent).toBe('');
    // 지금: action 링 + 번호 3
    expect(has(dot(2), 'border-ds-action')).toBe(true);
    expect(dot(2).textContent).toBe('3');
    expect(dot(2).querySelector('svg')).toBeNull();
    // 아직: line-control 경계 + 번호
    expect(has(dot(3), 'border-ds-line-control')).toBe(true);
    expect(dot(3).textContent).toBe('4');
    expect(dot(4).textContent).toBe('5');
  });

  it('⭐지금 단계만 aria-current="step" — 점은 장식(aria-hidden)이고 상태는 보이지 않는 글로 읽힌다', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={1} stateLabels={LABELS} />);
    expect(steps().map((s) => s.getAttribute('aria-current'))).toEqual([null, 'step', null, null, null]);
    expect(dot(1).getAttribute('aria-hidden')).toBe('true');
    const txt = (i: number) => steps()[i].querySelector('[data-slot="ds-stepper-label"]')!.textContent;
    expect(txt(0)).toBe('끝남 직무');
    expect(txt(1)).toBe('진행 중 스코프');
    expect(txt(2)).toBe('대기 실행환경');
    expect(steps()[0].querySelector('.sr-only')!.textContent).toBe('끝남 ');
  });

  it('⭐이은 선: 첫 단계엔 없고, 지금 단계까지는 done 색, 그 뒤는 line-control', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={2} stateLabels={LABELS} />);
    expect(steps()[0].className).not.toContain('before:absolute');
    expect(has(steps()[1], 'before:bg-ds-done')).toBe(true);
    expect(has(steps()[2], 'before:bg-ds-done')).toBe(true);
    expect(has(steps()[3], 'before:bg-ds-line-control')).toBe(true);
    expect(has(steps()[4], 'before:bg-ds-line-control')).toBe(true);
    expect(has(steps()[3], 'before:bg-ds-done')).toBe(false);
  });

  it('⭐단계는 같은 폭으로 나눠 갖고(flex-1 basis-0 min-w-0) 이름은 어절 중간에서 안 끊긴다(break-keep)', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={0} stateLabels={LABELS} />);
    for (const s of steps()) {
      expect(has(s, 'flex-1')).toBe(true);
      expect(has(s, 'basis-0')).toBe(true);
      expect(has(s, 'min-w-0')).toBe(true);
    }
    expect(has(list(), 'w-full')).toBe(true);
    const lab = steps()[0].querySelector('[data-slot="ds-stepper-label"]') as Element;
    expect(has(lab, 'break-keep')).toBe(true);
    // 한 낱말이 칸보다 길면(영문 «Connection» 등) 칸 안에서 접는다 — 옆 칸을 덮지 않는다.
    expect(has(lab, 'wrap-anywhere')).toBe(true);
    expect(has(lab, 'max-w-full')).toBe(true);
  });

  it('⭐이은 선은 논리 방향(start/end)이라 오른쪽→왼쪽 글에서도 앞 단계 쪽으로 뻗는다 — 물리 left/right 없음', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={2} stateLabels={LABELS} />);
    const c = steps()[1].className;
    expect(c.split(/\s+/)).toContain('before:end-1/2');
    expect(c.split(/\s+/)).toContain('before:start-[-50%]');
    expect(c).not.toMatch(/before:(left|right)-/);
  });

  it('지금 단계 이름은 굵게 · 끝은 ink-2 · 아직은 ink-3', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={1} stateLabels={LABELS} />);
    const lab = (i: number) => steps()[i].querySelector('[data-slot="ds-stepper-label"]') as HTMLElement;
    expect(has(lab(1), 'font-semibold')).toBe(true);
    expect(has(lab(1), 'text-ds-ink')).toBe(true);
    expect(has(lab(0), 'text-ds-ink-2')).toBe(true);
    expect(has(lab(2), 'text-ds-ink-3')).toBe(true);
    expect(has(lab(0), 'font-semibold')).toBe(false);
  });

  it('⭐current가 steps.length면 모두 끝 · 범위 밖(음수 · 큰 수 · NaN · 소수)은 가장자리로', async () => {
    const states = () => steps().map((s) => s.getAttribute('data-state')).join(',');
    await render(<Stepper aria-label="채용 단계" steps={STEPS.slice(0, 3)} current={3} stateLabels={LABELS} />);
    expect(states()).toBe('done,done,done');
    expect(steps().every((s) => s.getAttribute('aria-current') === null)).toBe(true);
    await render(<Stepper aria-label="채용 단계" steps={STEPS.slice(0, 3)} current={99} stateLabels={LABELS} />);
    expect(states()).toBe('done,done,done');
    await render(<Stepper aria-label="채용 단계" steps={STEPS.slice(0, 3)} current={Number.POSITIVE_INFINITY} stateLabels={LABELS} />);
    expect(states()).toBe('done,done,done');
    await render(<Stepper aria-label="채용 단계" steps={STEPS.slice(0, 3)} current={Number.NEGATIVE_INFINITY} stateLabels={LABELS} />);
    expect(states()).toBe('current,upcoming,upcoming');
    await render(<Stepper aria-label="채용 단계" steps={STEPS.slice(0, 3)} current={-4} stateLabels={LABELS} />);
    expect(states()).toBe('current,upcoming,upcoming');
    await render(<Stepper aria-label="채용 단계" steps={STEPS.slice(0, 3)} current={Number.NaN} stateLabels={LABELS} />);
    expect(states()).toBe('current,upcoming,upcoming');
    await render(<Stepper aria-label="채용 단계" steps={STEPS.slice(0, 3)} current={1.9} stateLabels={LABELS} />);
    expect(states()).toBe('done,current,upcoming');
  });

  it('⭐3단계(역할 없이)도 같은 부품 — 번호는 자리 순서', async () => {
    await render(<Stepper aria-label="채용 단계" steps={[STEPS[0], STEPS[1], { id: 'complete', label: '완료' }]} current={2} stateLabels={LABELS} />);
    expect(steps().length).toBe(3);
    expect(dot(2).textContent).toBe('3');
    expect(steps()[2].getAttribute('aria-current')).toBe('step');
  });

  it('호출부 className · data-*가 목록에 닿고 data-slot은 덮이지 않는다 · 단계가 없으면 빈 목록', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={0} stateLabels={LABELS} className="mt-2" data-testid="x" {...({ 'data-slot': 'evil' } as object)} />);
    expect(has(list(), 'mt-2')).toBe(true);
    expect(list().getAttribute('data-testid')).toBe('x');
    expect(list().getAttribute('data-slot')).toBe('ds-stepper');
    await render(<Stepper aria-label="채용 단계" steps={[]} current={0} stateLabels={LABELS} />);
    expect(steps().length).toBe(0);
  });

  it('⭐눌리는 부품이 아니다 — 단추 · 링크 · tabindex 없음', async () => {
    await render(<Stepper aria-label="채용 단계" steps={STEPS} current={2} stateLabels={LABELS} />);
    expect(container.querySelector('button, a, [tabindex]')).toBeNull();
  });
});
