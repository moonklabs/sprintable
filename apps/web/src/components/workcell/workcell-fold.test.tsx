// @vitest-environment jsdom
//
// 4908 — 카드 상세의 «작업 칸» 한 줄 접힘. 첫 화면 맨 위는 제목 · 상태 · 담당자 · 속성이 쓰고, 작업 칸은 있는 기능 그대로 한 번 눌러 펼친다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { LAYER } from '@/components/ds/layers';
import { WorkcellFold, type WorkcellFoldProps } from './workcell-fold';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: WorkcellFoldProps = {
  title: '결제 복구 플로우',
  pipelineStage: 'running',
  currentStageLabel: '진행중',
  brief: { goal: '실패한 결제를 재시도로 복구', dod: '자동검증 passed', owner: { name: '윤재', role: '책임' } },
  run: { now: '진행중', stage: '진행중', tools: [], scopes: [], blocked: null, nextNeed: '리뷰 대기' },
  evidence: null,
  conversation: { view: 'run', messages: [] },
  evidenceCount: 0,
  conversationCount: 0,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => { root.unmount(); }); container.remove(); });

function mount(props: Partial<WorkcellFoldProps> = {}, locale: 'ko' | 'en' = 'ko') {
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <WorkcellFold {...BASE} {...props} />
      </NextIntlClientProvider>,
    );
  });
  return {
    toggle: container.querySelector<HTMLButtonElement>('[data-testid="workcell-fold-toggle"]')!,
    summary: () => container.querySelector('[data-testid="workcell-fold-summary"]')!.textContent,
  };
}

describe('4908 작업 칸 접힘 — 기본은 접힌 한 줄', () => {
  it('⭐접힌 채로 서고(aria-expanded=false) 한 줄 요약 «단계 n/6 · 근거 · 대화»만 보인다 — 작업 칸 본체는 그리지 않는다', () => {
    const { toggle, summary } = mount();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(summary()).toBe('단계 2/6 · 근거 0 · 대화 0');
    expect(container.textContent).not.toContain(koMessages.workcell.briefTitle);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.workcell.foldTitle);
    expect(toggle.textContent).toContain(koMessages.workcell.foldExpand);
  });

  it.each([
    ['queued', 1], ['running', 2], ['needs_input', 3], ['claimed_done', 4], ['verified', 5], ['merge_ready', 6],
  ] as const)('단계 %s → «단계 %i/6» (게이지가 세는 것과 같다)', (stage, n) => {
    const { summary } = mount({ pipelineStage: stage });
    expect(summary()).toBe(`단계 ${n}/6 · 근거 0 · 대화 0`);
  });

  it('⭐근거 · 대화 수는 받은 수 그대로 · 대화를 아직 모르면(불러오는 중) «0»이라 단정하지 않고 «–»', () => {
    expect(mount({ evidenceCount: 2, conversationCount: 5 }).summary()).toBe('단계 2/6 · 근거 2 · 대화 5');
    expect(mount({ conversationCount: undefined }).summary()).toBe('단계 2/6 · 근거 0 · 대화 –');
  });

  it('파이프라인 밖(done · pipelineStage=null)은 단계 수를 지어내지 않고 «파이프라인 범위 밖»', () => {
    const { summary } = mount({ pipelineStage: null, evidenceCount: 1, conversationCount: 3 });
    expect(summary()).toBe('파이프라인 범위 밖 · 근거 1 · 대화 3');
  });

  it('영어도 같은 꼴', () => {
    expect(mount({}, 'en').summary()).toBe('Step 2/6 · Evidence 0 · Conversation 0');
  });

  it('⭐접힌 줄은 눌러 펼치는 단추다 — 최소 높이 44(min-h-11) · 층 토큰 면(rowOthers) + 경계', () => {
    const { toggle } = mount();
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-11', 'border', 'border-ds-line', LAYER.rowOthers]));
  });
});

describe('4908 작업 칸 접힘 — 펼침', () => {
  it('⭐누르면 작업 칸이 열리고(aria-expanded=true · aria-controls = 본체 id) 다시 누르면 접힌다', () => {
    const { toggle } = mount();
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body).not.toBeNull();
    expect(body.textContent).toContain(koMessages.workcell.briefTitle);
    expect(body.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(toggle.textContent).toContain(koMessages.workcell.foldCollapse);
    act(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('⭐펼친 작업 칸은 제목 · 상태를 되풀이하지 않는다 — 제목 0 · 게이지 밑 상태 글자 0 · «지금 / 단계» 줄 0 (머리가 맡는다)', () => {
    const { toggle } = mount();
    act(() => { toggle.click(); });
    expect(container.textContent).not.toContain(BASE.title);
    expect(container.querySelector('[data-testid="workcell-current-stage"]')).toBeNull();
    expect(container.textContent).not.toContain(`${koMessages.workcell.runNow}:`);
    // 상태 글자(진행중)는 작업 칸 어디에도 다시 나오지 않는다 — 게이지 밑 · 지금 · 단계 세 자리가 다 같은 글자였다.
    expect(container.textContent).not.toContain('진행중');
    // 없앤 것은 되풀이뿐 — 다음 요구 · 막힘 · 구획 이름은 그대로.
    expect(container.textContent).toContain('리뷰 대기');
    expect(container.textContent).toContain(koMessages.workcell.runBlocked);
    expect(container.textContent).toContain(koMessages.workcell.evidenceTitle);
  });

  it('⭐파생 단계(상태 글자가 없는 입력 필요 · 검증됨 · 병합 대기)는 게이지 밑 단계 글자를 그대로 둔다 — 머리에 그 말이 없으니까', () => {
    const { toggle } = mount({ pipelineStage: 'needs_input', currentStageLabel: undefined });
    act(() => { toggle.click(); });
    expect(container.querySelector('[data-testid="workcell-current-stage"]')?.textContent).toBe(koMessages.workcell.pipelineNeedsInput);
  });

  it('⭐설명이 없으면 제목을 목표 자리에 대신 넣지 않고 «설명 미기재»', () => {
    const { toggle } = mount({ brief: { ...BASE.brief, goal: null } });
    act(() => { toggle.click(); });
    expect(container.textContent).toContain(koMessages.workcell.briefGoalMissing);
    expect(container.textContent).not.toContain(BASE.title);
  });

  it('⭐거친 결(proof-surface · 뜬 그림자) 판이 아니라 층 토큰 면이다 — 바깥 판 rowOthers · 안의 칸 panel', () => {
    const { toggle } = mount();
    act(() => { toggle.click(); });
    const markup = container.innerHTML;
    expect(markup).not.toContain('proof-surface');
    expect(markup).not.toContain('--elev-card');
    const plate = document.getElementById(toggle.getAttribute('aria-controls')!)!.firstElementChild as HTMLElement;
    expect(plate.className.split(/\s+/)).toEqual(expect.arrayContaining([LAYER.rowOthers, 'border', 'border-ds-line']));
    const cells = [...container.querySelectorAll<HTMLElement>('[id] .grid > div.overflow-hidden')];
    expect(cells.length).toBe(4);
    for (const c of cells) expect(c.className.split(/\s+/), c.className).toContain(LAYER.panel);
  });
});
