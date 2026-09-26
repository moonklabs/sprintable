// @vitest-environment jsdom
// [SID:4311 PR 3] 내 체크인 쓰기의 «계획 스토리 고르기» 담당 칩 — 스프린트 목록과 같은 규칙(담당 없음 «담당자 없음» · 이름 빔 · 표에 없음 ·
// 같은 이름 둘은 «· ID 앞 8자»). 고르기 칸은 내 카드의 «쓰기»를 눌러야 서서, 카드 목을 «쓰기» 단추로 둔다(standup-client.test.tsx는 카드 목 = null).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/components/standup/board-bridge-modal', () => ({ BoardBridgeModal: () => null }));
vi.mock('@/components/standup/standup-board-card', () => ({
  StandupBoardCard: ({ member, onEdit }: { member: { id: string }; onEdit?: () => void }) => (
    onEdit ? <button type="button" data-testid={`edit-${member.id}`} onClick={onEdit}>edit</button> : null
  ),
}));
vi.mock('@/components/standup/standup-feedback-dialog', () => ({ StandupFeedbackDialog: () => null }));
vi.mock('@/components/standup/standup-history-section', () => ({ StandupHistorySection: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [] });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('StandupClient — 계획 스토리 고르기 담당 칩([SID:4311 PR 3])', () => {
  it('담당 없음 · 이름 빔 · 표에 없음을 가르고 «송윤재» 둘은 꼬리로 갈린다', async () => {
    const story = (id: string, title: string, assignee_id: string | null) => ({ id, title, status: 'in-progress', assignee_id, sprint_id: 'sp1', project_id: 'p1' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url !== 'string') return { ok: false, json: async () => null };
      if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/team-members')) {
        return { ok: true, json: async () => ({ data: [
          { id: 'me-1', name: '나나', type: 'human' },
          { id: 'e75ca548-1', name: '송윤재', type: 'human' },
          { id: '2fd14616-2', name: '송윤재', type: 'human' },
          { id: 'm-noname', name: null, type: 'human' },
        ] }) };
      }
      if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [{ id: 'sp1', title: '진행중 스프린트', status: 'active', start_date: null, end_date: null }] }) };
      if (url.includes('/api/standup/feedback')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/standup/missing')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/stories?project_id=')) {
        return { ok: true, json: async () => ({ data: [
          story('s1', '첫 일감', 'e75ca548-1'), story('s2', '둘째 일감', '2fd14616-2'), story('s3', '셋째 일감', null),
          story('s4', '넷째 일감', 'm-noname'), story('s5', '다섯째 일감', 'm-gone'),
        ], meta: {} }) };
      }
      if (url.includes('/api/tasks?story_id=')) return { ok: true, json: async () => ({ data: [], meta: { totalCount: 0, doneCount: 0 } }) };
      return { ok: false, json: async () => null };
    }));
    const { default: StandupPage } = await import('./standup-client');
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StandupPage projectId="proj-1" /></NextIntlClientProvider>);
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { (container.querySelector('[data-testid="edit-me-1"]') as HTMLButtonElement).click(); });
    const pickerChip = (title: string) => {
      const label = [...container.querySelectorAll('label')].find((el) => el.querySelector('p')?.textContent === title);
      return label?.querySelector('p')?.parentElement?.nextElementSibling?.firstElementChild?.textContent;
    };
    expect(pickerChip('첫 일감')).toBe('송윤재 · e75ca548');
    expect(pickerChip('둘째 일감')).toBe('송윤재 · 2fd14616');
    expect(pickerChip('셋째 일감')).toBe(koMessages.board.unassigned);
    expect(pickerChip('넷째 일감')).toBe(koMessages.common.memberUnnamed);
    expect(pickerChip('다섯째 일감')).toBe(koMessages.common.memberUnknown);
  });
});
