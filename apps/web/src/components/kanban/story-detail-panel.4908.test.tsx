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
  it('⭐속성 칸과 본문 칸이 따로 선다 · 속성 칸은 좁은 폭에서 본문 앞(order-first), lg 이상에서 오른쪽(lg:order-last)', async () => {
    const { rail, main } = await mount();
    expect(rail).not.toBeNull();
    expect(main).not.toBeNull();
    expect(rail!.tagName).toBe('ASIDE');
    expect(rail!.getAttribute('aria-label')).toBe(koMessages.board.detailProperties);
    const c = rail!.className.split(/\s+/);
    expect(c).toEqual(expect.arrayContaining(['order-first', 'lg:order-last']));
    expect(rail!.contains(main!)).toBe(false);
  });

  it('⭐속성 칸: 담당 · 포인트가 들어 있고, 본문 칸에는 없다', async () => {
    const { rail, main } = await mount();
    expect(rail!.textContent).toContain(koMessages.board.assignee);
    expect(main!.textContent).not.toContain(koMessages.board.assignee);
  });

  it('⭐본문 칸: 설명 · 완료 조건 · 탭(Tasks / 댓글 / 활동)이 들어 있고, 속성 칸에는 없다', async () => {
    const { rail, main } = await mount();
    expect(main!.textContent).toContain('설명 본문');
    expect(main!.textContent).toContain('완료 조건 본문');
    expect(main!.querySelector('[role="tablist"]')).not.toBeNull();
    expect(rail!.textContent).not.toContain('설명 본문');
    expect(rail!.querySelector('[role="tablist"]')).toBeNull();
  });

  it('구역을 없앤 것은 없다 — 두 칸을 합치면 옛 판의 구역이 전부 있다(담당 · 설명 · 완료 조건 · 탭)', async () => {
    const { rail, main } = await mount();
    const all = `${rail!.textContent}${main!.textContent}`;
    for (const needle of [koMessages.board.assignee, '설명 본문', '완료 조건 본문']) expect(all, needle).toContain(needle);
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
    expect(container.textContent).toContain('송윤재 검증');
    expect(container.textContent).toMatch(/송윤재 검증 · \S+/); // 검증자 뒤에 시각이 붙는다
  });
});
