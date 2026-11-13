// @vitest-environment jsdom
//
// 4908 (일곱째) — 카드 상세 패널 안에서 «옛 proof 팔레트로 풀리는 부품»이 0이어야 한다. 옛 shadcn 토큰(bg-background · bg-muted · bg-secondary · bg-primary · bg-card · bg-popover · bg-accent)과 proof-* 클래스는
// 바탕을 옛 미색(라이트 247,246,243 / 241,239,234 · 다크 같은 짝)으로 풀어, 차가운 ds 면(서랍 → 속성 칸 → 안 칸) 위에 두 번째 바탕을 깔았다(PO 11-13 전체 화면 판정).
// 이 시험은 «렌더된 패널 DOM 전체»(+ 포털로 뜬 메뉴)에서 그 클래스를 센다 — 부품을 옛것으로 되돌리면 빨개진다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human', currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [] }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 옛 팔레트 클래스: 수식자(hover: · dark: · focus: …)와 투명도(/30)가 붙어도 잡는다. */
const LEGACY = /^(?:[\w-]+:)*(?:bg-(?:background|muted|secondary|primary|card|popover|accent|input)(?:\/\d+)?|(?:bg|border|text|ring|fill|stroke|from|to|via|divide|outline)-proof-[\w-]+(?:\/\d+)?|proof-surface[\w-]*)$/;

const story = {
  id: 's1', story_number: 4908, title: '보드 재건축', status: 'in-progress', priority: 'medium', trust_stage: 'running',
  story_points: 5, assignee_id: 'a1', assignee_ids: ['a1'], epic_id: null, sprint_id: null,
  description: '설명 본문', acceptance_criteria: '완료 조건 본문', attachments: [], position: null,
  success_hypothesis: null, metric_definition: null, measure_after: null, outcome_status: 'n_a', outcome_result: null,
  self_reported: true,
} as unknown as KanbanStory;
const memberMap = { a1: { id: 'a1', name: '빌드 에이전트', type: 'agent' }, h1: { id: 'h1', name: '안나', type: 'human' } } as never;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/api\/labels/.test(u)) return { ok: true, json: async () => [{ id: 'l1', name: '후보라벨', color: '#3E7DC2' }] };
    if (/\/api\/item-labels/.test(u)) return { ok: true, json: async () => [{ id: 'il1', label_id: 'l1' }] };
    if (/rejected-relations/.test(u)) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => ({ data: [] }) };
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

async function mount(st: KanbanStory = story) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          <StoryDetailPanel story={st} tasks={[{ id: 't1', title: '태스크', status: 'todo' } as never]} onClose={() => {}} projectId="p1" memberMap={memberMap} />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

/** 패널 + 포털(메뉴 · 팝오버)까지 — 옛 클래스를 가진 요소를 «클래스 · 위치 힌트»로 모은다. */
function legacyHits(): string[] {
  const hits = new Map<string, number>();
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    if (el.closest(SHARED)) continue;
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
    for (const c of cls) {
      if (!c || !LEGACY.test(c)) continue;
      const where = el.closest('[data-testid]')?.getAttribute('data-testid') ?? el.closest('[role="dialog"]') ? (el.closest('[data-testid]')?.getAttribute('data-testid') ?? 'dialog') : 'outside';
      const key = `${c}  <${el.tagName.toLowerCase()}${el.getAttribute('data-slot') ? ` ${el.getAttribute('data-slot')}` : ''}> in ${where}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  return [...hits.entries()].map(([k, n]) => `${n}× ${k}`).sort();
}

/** 이 장 밖의 공용 부품(여러 화면이 같이 쓰는 것): 증거 캡슐(게이트 · 결재 · 목표 화면) · 아바타(채팅 · 목록 …) — 안쪽의 옛 클래스는 그 부품을 바꾸는 장의 몫이다. */
const SHARED = '[data-slot="proof-capsule"], [data-slot="avatar"]';
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); await Promise.resolve(); });
const byText = (re: RegExp, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('button, [role="tab"], [role="menuitem"]')].find((b) => re.test(b.textContent ?? ''));

/** 패널이 낼 수 있는 «열린 상태»를 차례로 열며 옛 클래스 히트를 상태 이름별로 모은다(히트가 없는 상태는 빼서 실패 메시지가 곧 일 목록이 된다). */
async function walkStates(): Promise<Record<string, string[]>> {
  const report: Record<string, string[]> = {};
  const note = (name: string) => { const h = legacyHits(); if (h.length) report[name] = h; };
  note('default');
  await click(document.querySelector('[data-testid="workcell-fold-toggle"]'));
  note('workcellExpanded');
  await click(document.querySelector('[data-testid="workcell-fold-toggle"]'));
  await click(document.querySelector('button[aria-label="상태"]'));
  note('statusMenu');
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  const main = document.querySelector('[data-testid="story-detail-main"]')!;
  for (const [name, re] of [['commentsTab', /댓글/], ['activityTab', /활동/]] as const) { await click(byText(re, main)); note(name); }
  await click(byText(/편집/, document.querySelector('[data-testid="story-detail-properties"]')!));
  note('assigneePicker');
  await click(document.querySelector(`button[aria-label="${koMessages.board.deleteStory}"]`));
  note('deleteConfirm');
  return report;
}

describe('4908 카드 상세 — 옛 proof 팔레트 부품 0 (머리 · 몸통 · 속성 칸 · 열린 메뉴)', () => {
  it('⭐근거(검증 봉인)가 없는 장: 기본 · 작업 칸 펼침 · 상태 메뉴 · 댓글 탭 · 활동 탭 · 담당자 고르기 — 어느 상태에도 옛 클래스 0', async () => {
    await mount({ ...story, self_reported: false } as KanbanStory);
    expect(await walkStates()).toEqual({});
  });

  it('⭐근거 칸에 공용 증거 캡슐(ProofCapsule)이 선 장: 옛 클래스는 공용 부품(캡슐 · 아바타) «안»에만 남는다(여러 화면이 같이 쓰는 부품이라 이 장 밖 — 패널 쪽은 0)', async () => {
    await mount(story);
    await click(document.querySelector('[data-testid="workcell-fold-toggle"]'));
    expect(document.querySelector('[data-slot="proof-capsule"]'), '캡슐이 실제로 섰는지(양성 대조)').not.toBeNull();
    await click(document.querySelector('button[aria-label="상태"]'));
    const outside: string[] = [];
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      if (el.closest(SHARED)) continue;
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
      for (const c of cls) if (c && LEGACY.test(c)) outside.push(`${c} <${el.tagName.toLowerCase()}> ${el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}`);
    }
    expect(outside).toEqual([]);
  });

  it('⭐삭제 확인 창은 ds 확인 창(ds-dialog-content · 위험 단추)이다 — 옛 Dialog가 아니다', async () => {
    await mount({ ...story, self_reported: false } as KanbanStory);
    await click(document.querySelector(`button[aria-label="${koMessages.board.deleteStory}"]`));
    const dlg = document.querySelector('[data-slot="ds-dialog-content"]');
    expect(dlg, '삭제 확인 창').not.toBeNull();
    expect(dlg!.textContent).toContain(koMessages.board.permanentDelete);
  });

  it('⭐옛 부품으로 되돌리면 빨개진다 — 판별 시험: ui Button(ghost)의 hover:bg-muted · aria-expanded:bg-muted 같은 옛 클래스를 이 정규식이 잡는다', () => {
    for (const c of ['hover:bg-muted', 'aria-expanded:bg-muted', 'dark:hover:bg-muted/50', 'bg-background', 'dark:bg-input/30', 'bg-primary', 'bg-card', 'bg-popover', 'bg-secondary', 'bg-accent', 'bg-muted/30', 'text-proof-ink', 'border-proof-line', 'ring-proof-blue/20', 'proof-surface', 'proof-surface-press', 'focus-visible:border-proof-citron']) expect(LEGACY.test(c), c).toBe(true);
    for (const c of ['bg-ds-surface', 'bg-ds-surface-high', 'bg-ds-action', 'text-ds-ink', 'hover:bg-ds-surface-high', 'border-ds-line', 'bg-transparent', 'text-muted-foreground', 'bg-ds-ink-3/20']) expect(LEGACY.test(c), c).toBe(false);
  });
});
