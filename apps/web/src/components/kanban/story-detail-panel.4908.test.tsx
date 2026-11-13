// @vitest-environment jsdom
//
// 4908 — 카드 상세 «본문 / 속성 칸» 분리 구조 가드. 예전에는 19개 구역이 한 줄로 길게 이어졌다(담당 · 레시피 · 디스패치 · 포인트 · 라벨 · PR이 설명 · 의존성 · 탭 사이에 섞여 있었다).
// 이제 오른쪽(좁은 폭에서는 본문 앞) 속성 칸에 «바꾸는 값»(담당 · 레시피 · 디스패치 · 포인트 · 라벨 · PR)이, 본문 칸에 «읽고 쓰는 글»(설명 · 완료 조건 · 첨부 · 의존성 · 연결 · 결과 · 탭)이 선다. 구역을 옮기기만 했고 없앤 것은 없다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';
import { LAYER } from '@/components/ds/layers';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human' }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const story: KanbanStory = {
  id: 's1', story_number: 4908, title: '보드 재건축', status: 'in-progress', priority: 'medium',
  story_points: 5, assignee_id: null, epic_id: null, sprint_id: null,
  description: '설명 본문', acceptance_criteria: '완료 조건 본문', attachments: [], position: null,
  success_hypothesis: null, metric_definition: null, measure_after: null, outcome_status: 'n_a', outcome_result: null,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => (/rejected-relations|\/api\/labels|\/api\/item-labels/.test(String(url)) ? [] : { data: [] }) })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider><StoryDetailPanel story={story} tasks={[]} onClose={() => {}} projectId="p1" /></ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  const rail = container.querySelector<HTMLElement>('[data-testid="story-detail-properties"]');
  const main = container.querySelector<HTMLElement>('[data-testid="story-detail-main"]');
  return { rail, main };
}

describe('4908 카드 상세 — 본문 / 속성 칸', () => {
  it('⭐속성 칸과 본문 칸이 따로 선다 · 속성 칸은 DOM에서 본문 앞(좁은 폭: 위 · 초점 순서도 앞), lg 이상에서 오른쪽 열 맨 위에 붙는다(lg:sticky · col-start-2)', async () => {
    const { rail, main } = await mount();
    expect(rail).not.toBeNull();
    expect(main).not.toBeNull();
    expect(rail!.tagName).toBe('ASIDE');
    expect(rail!.getAttribute('aria-label')).toBe(koMessages.board.detailProperties);
    const c = rail!.className.split(/\s+/);
    expect(c).toEqual(expect.arrayContaining(['lg:sticky', 'lg:top-0', 'lg:col-start-2', 'lg:row-start-1', 'lg:row-span-2', 'lg:self-start']));
    expect(c).not.toContain('order-first');
    expect(c).not.toContain('lg:order-last');
    expect(rail!.contains(main!)).toBe(false);
    expect(rail!.compareDocumentPosition(main!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main!.className.split(/\s+/)).toEqual(expect.arrayContaining(['lg:col-start-1', 'lg:row-start-2']));
  });

  it('⭐순서: 작업 칸 한 줄(접힘) → 속성 칸 → 본문 — 좁은 폭에서 담당 · 상태가 첫 화면에 들도록 작업 칸은 접혀 있다', async () => {
    const { rail, main } = await mount();
    const fold = container.querySelector<HTMLElement>('[data-testid="workcell-fold"]')!;
    const toggle = container.querySelector<HTMLElement>('[data-testid="workcell-fold-toggle"]')!;
    expect(fold).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(fold.compareDocumentPosition(rail!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rail!.compareDocumentPosition(main!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fold.className.split(/\s+/)).not.toContain('lg:col-start-2');
    expect(fold.parentElement!.className.split(/\s+/)).toEqual(expect.arrayContaining(['lg:col-start-1', 'lg:row-start-1']));
  });

  it('⭐같은 말은 한 자리: 제목 · 상태 글자가 접힌 채로도 펼친 뒤로도 한 번씩만 있다(제목 3번 · 상태 5번이던 것)', async () => {
    await mount();
    const count = (needle: string) => (container.textContent ?? '').split(needle).length - 1;
    const statusWord = koMessages.board.inProgress;
    expect(count(story.title)).toBe(1);
    expect(count(statusWord)).toBe(1);
    const toggle = container.querySelector<HTMLElement>('[data-testid="workcell-fold-toggle"]')!;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain(koMessages.workcell.briefTitle);
    expect(count(story.title)).toBe(1);
    expect(count(statusWord)).toBe(1);
  });

  const B = koMessages.board;

  it('⭐서랍은 내용 칸 층(LAYER.panel)이고 옛 bg-background가 아니다 · 속성 칸은 한 단 다른 면(LAYER.rowOthers) + 경계', async () => {
    const { rail } = await mount();
    const drawer = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const dc = drawer.className.split(/\s+/);
    expect(dc).toContain(LAYER.panel);
    expect(dc).not.toContain('bg-background');
    const rc = rail!.className.split(/\s+/);
    expect(rc).toContain(LAYER.rowOthers);
    expect(rc).toEqual(expect.arrayContaining(['border', 'border-ds-line']));
    expect(rc).not.toContain(LAYER.panel);
  });

  it('⭐속성 칸 안의 라벨 후보 칩 · 새 라벨 입력칸은 옛 bg-background가 아니라 내용 칸 면(bg-ds-surface)이다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (/\/api\/item-labels/.test(u)) return { ok: true, json: async () => [] };
      if (/\/api\/labels/.test(u)) return { ok: true, json: async () => [{ id: 'l1', name: '후보라벨', color: '#3E7DC2' }] };
      return { ok: true, json: async () => (/rejected-relations/.test(u) ? [] : { data: [] }) };
    }));
    const { rail } = await mount();
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    const add = [...rail!.querySelectorAll('button')].find((b) => b.textContent === B.addGeneric)!;
    await act(async () => { add.click(); });
    const chip = [...rail!.querySelectorAll('button')].find((b) => b.textContent?.includes('후보라벨'))!;
    expect(chip.className.split(/\s+/)).toContain('bg-ds-surface');
    expect(chip.className.split(/\s+/)).not.toContain('bg-background');
    const input = rail!.querySelector<HTMLInputElement>('input')!;
    expect(input.className.split(/\s+/)).toEqual(expect.arrayContaining(['bg-ds-surface', 'dark:bg-ds-surface']));
    expect(input.className.split(/\s+/)).not.toContain('bg-background');
  });

  it('⭐지도 위 소형 서랍(overlayPosition)도 내용 칸 층이다 — 옛 bg-background가 아니다', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ToastProvider><StoryDetailPanel story={story} tasks={[]} onClose={() => {}} projectId="p1" overlayPosition={{ top: 10, heightPx: 400 }} /></ToastProvider>
        </NextIntlClientProvider>,
      );
    });
    const dc = container.querySelector<HTMLElement>('[role="dialog"]')!.className.split(/\s+/);
    expect(dc).toContain(LAYER.panel);
    expect(dc).not.toContain('bg-background');
  });

  it('⭐속성 칸 안의 흐린 글(muted-foreground)은 ds-ink-3로 — 속성 칸 면 위 다크 대비 4.5:1', async () => {
    const { rail } = await mount();
    expect(rail!.className).toContain('[--muted-foreground:var(--ds-ink-3)]');
  });
  // 속성 칸의 머리글(바꾸는 값) · 본문 칸의 머리글(읽고 쓰는 글) — 구역 이름을 하나씩 짚는다.
  const RAIL_HEADS = [B.assignee, B.storyPoints, B.labelsSectionTitle];
  const MAIN_HEADS = [B.description, B.acceptanceCriteria, B.attachments, B.dependenciesSectionTitle];

  it('⭐속성 칸에는 담당 · 포인트 · 라벨이, 본문 칸에는 없다', async () => {
    const { rail, main } = await mount();
    for (const h of RAIL_HEADS) {
      expect(rail!.textContent, `속성 칸: ${h}`).toContain(h);
      expect(main!.textContent, `본문 칸에 새면 안 됨: ${h}`).not.toContain(h);
    }
  });

  it('⭐본문 칸에는 설명 · 완료 조건 · 첨부 · 의존성 · 탭이 있고, 속성 칸에는 없다', async () => {
    const { rail, main } = await mount();
    for (const h of MAIN_HEADS) {
      expect(main!.textContent, `본문 칸: ${h}`).toContain(h);
      expect(rail!.textContent, `속성 칸에 새면 안 됨: ${h}`).not.toContain(h);
    }
    expect(main!.textContent).toContain('설명 본문');
    expect(main!.textContent).toContain('완료 조건 본문');
    expect(main!.querySelector('[role="tablist"]')).not.toBeNull();
    expect(rail!.querySelector('[role="tablist"]')).toBeNull();
  });

  it('구역을 없앤 것은 없다 — 두 칸을 합치면 옛 판의 구역 머리글이 전부 있다', async () => {
    const { rail, main } = await mount();
    const all = `${rail!.textContent}${main!.textContent}`;
    for (const h of [...RAIL_HEADS, ...MAIN_HEADS]) expect(all, h).toContain(h);
  });

  it('⭐디스패치(projectId가 있을 때)는 속성 칸에 있다', async () => {
    const { rail, main } = await mount();
    expect(rail!.textContent).toContain(B.dispatch);
    expect(main!.textContent).not.toContain(B.dispatch);
  });

  async function settle() { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); }
  const LONG = '아주아주아주아주아주아주아주아주아주아주아주아주긴조직라벨이름';
  const stubLabels = (attached: boolean) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/api\/item-labels/.test(u)) return { ok: true, json: async () => (attached ? [{ id: 'il1', label_id: 'l1' }] : []) };
    if (/\/api\/labels/.test(u)) return { ok: true, json: async () => [{ id: 'l1', name: LONG, color: '#3E7DC2' }] };
    return { ok: true, json: async () => (/rejected-relations/.test(u) ? [] : { data: [] }) };
  }));

  it('⭐긴 조직 라벨 이름이 16rem 속성 칸 밖으로 안 나간다 — 라벨 후보 버튼은 줄바꿈 · 꺾임', async () => {
    stubLabels(false);
    const { rail } = await mount();
    await settle();
    const add = [...rail!.querySelectorAll('button')].find((b) => b.textContent === B.addGeneric);
    expect(add, '라벨 추가 버튼').toBeTruthy();
    await act(async () => { add!.click(); });
    const pick = [...rail!.querySelectorAll('button')].find((b) => b.textContent?.includes(LONG));
    expect(pick, '라벨 후보 버튼').toBeTruthy();
    expect(pick!.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-w-full', 'whitespace-normal', '[overflow-wrap:anywhere]']));
  });

  it('⭐붙은 긴 라벨 칩은 칸 폭까지(max-w-full)만 — 칩 자체는 이름을 줄임표로 줄인다', async () => {
    stubLabels(true);
    const { rail } = await mount();
    await settle();
    const chipWrap = [...rail!.querySelectorAll('span.group')].find((n) => n.textContent?.includes(LONG));
    expect(chipWrap, '붙은 라벨 칩 묶음').toBeTruthy();
    expect(chipWrap!.className.split(/\s+/)).toContain('max-w-full');
    expect(chipWrap!.querySelector('.truncate')?.textContent).toBe(LONG);
  });
});

// PO 11-12 — 카드의 씰이 아이콘 + 툴팁이 됐다. 호버 없는 폰에서 «누가 · 언제 검증»은 카드를 눌러 연 상세에서 글로 보여야 한다.
describe('4908 카드 상세 — 검증자 · 검증 시각은 글로 보인다(카드 씰은 아이콘뿐)', () => {
  it('⭐human_verified → 상세 머리에 «{이름} 검증 · {언제}»가 글로 있다', async () => {
    const verified = { ...story, status: 'done', human_verified: true, human_verified_by: 'h1', human_verified_at: '2026-11-12T01:00:00Z' } as KanbanStory;
    const memberMap = { h1: { id: 'h1', name: '송윤재', type: 'human' } } as never;
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ToastProvider><StoryDetailPanel story={verified} tasks={[]} onClose={() => {}} projectId="p1" memberMap={memberMap} /></ToastProvider>
        </NextIntlClientProvider>,
      );
    });
    // 증거 구역의 씰 줄(눌러 펼치는 버튼) 하나를 짚는다 — 다른 구역에도 «검증»이 있어 전체 글이 아니라 이 줄로 잰다.
    const sealRow = [...container.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent?.includes('송윤재 검증'));
    expect(sealRow, '증거 구역 씰 줄').toBeTruthy();
    expect(sealRow!.textContent).toMatch(/송윤재 검증 · \S+/); // 검증자 뒤에 시각이 붙는다 — 시각이 안 내려오면 «송윤재 검증»만 남는다
  });
});

// 더블클릭 = 열기(PO 11-12 · 저장소 5668/5690 · 결재함 행 · 에이전트 목록과 같은 뜻): 카드를 두 번 누르면 첫 클릭이 서랍을 열고 그 자리에 깔린 배경 막을 둘째 클릭이 눌러 서랍을 닫던 것을, 시간이 아니라 클릭 횟수로 막는다.
describe('4908 서랍 배경 막 — 둘째 이후 클릭은 «카드로 막 연» 동안 서랍을 닫지 않는다(5690의 꼴)', () => {
  const onClose = vi.fn();
  beforeEach(() => { onClose.mockReset(); });
  async function mountWith() {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ToastProvider><StoryDetailPanel story={story} tasks={[]} onClose={onClose} projectId="p1" /></ToastProvider>
        </NextIntlClientProvider>,
      );
    });
    return container.querySelector<HTMLElement>('div[aria-hidden="true"].fixed.inset-0')!;
  }
  const clickWith = (el: Element, detail: number) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); });

  it('⭐서랍이 막 선 동안 막에 닿는 둘째 이후 클릭(detail 2 · 3)은 서랍을 닫지 않는다 — 더블클릭 = 열기', async () => {
    const backdrop = await mountWith();
    clickWith(backdrop, 2);
    clickWith(backdrop, 3);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('⭐막을 «처음» 누르면(detail 1) 지금처럼 닫힌다 · 키보드로 눌러도(detail 0) 닫힌다', async () => {
    const backdrop = await mountWith();
    clickWith(backdrop, 1);
    expect(onClose).toHaveBeenCalledTimes(1);
    clickWith(backdrop, 0);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('⭐서랍 안쪽을 누른 뒤에는(표식이 지워짐) 막에 닿는 detail 2 클릭도 닫는다 — 막 연 직후만 무시', async () => {
    const backdrop = await mountWith();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => { dialog.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    clickWith(backdrop, 2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('⭐막을 한 번 처음 눌러 표식이 지워진 뒤에는 detail 2도 닫는다', async () => {
    const backdrop = await mountWith();
    clickWith(backdrop, 1);
    onClose.mockReset();
    clickWith(backdrop, 2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
