// @vitest-environment jsdom
//
// [SID:4369] 스토리 패널 댓글 칸에 글을 쓰다 Esc → 패널이 통째로 닫히고 쓴 댓글이 사라졌다(PO 라이브 재현 · 배포 36 · 1440/390).
// 댓글 칸은 «안쪽 층»이 없어 4749(4367)의 «안쪽이 쓴 Esc는 건너뜀» 계약 밖이다 — 패널 window Esc가 곧바로 onClose였다.
// 유나 규칙(스토리 본문 · 2026-09-27):
//   ① 한글 조합 중 Esc = 조합만 취소(패널 · 칸 그대로)
//   ② 글 있음 → 첫 Esc = 칸에서만 빠져나옴(글 유지 · 초점은 층 뿌리 tabIndex=-1) · 둘째 Esc = 닫힘
//   ③ 글 없음 → 한 번에 닫힘
//   ④ 초안은 닫는 길과 무관하게 남음(Esc · ✕ · 바깥 누름 · 다른 스토리로 이동 → 다시 열면 그대로 · sessionStorage · 보내기 성공 때만 지움)
//   ⑤ 확인 창 · 새 문구 0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { ToastProvider } from '@/components/ui/toast';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let postOk = true;

const makeStory = (id: string, title: string) => ({
  id, story_number: 1, title, status: 'backlog', priority: 'medium', story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
  description: null, acceptance_criteria: null, attachments: null, position: null, success_hypothesis: null, metric_definition: null, measure_after: null,
  outcome_status: 'n_a', outcome_result: null,
}) as KanbanStory;
const S1 = makeStory('s1', '댓글 Esc 1');
const S2 = makeStory('s2', '댓글 Esc 2');

beforeEach(() => {
  postOk = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/comments')) {
      return (postOk
        ? new Response(JSON.stringify({ data: { id: 'c1', content: 'x', created_at: '2026-09-27T00:00:00Z', created_by: 'me-1' } }), { status: 201 })
        : new Response(JSON.stringify({ error: { code: 'X', message: 'fail' } }), { status: 500 }));
    }
    return { ok: false, json: async () => null } as unknown as Response;
  }));
  // 이 jsdom 환경은 sessionStorage를 안 줄 수 있다 — 테스트마다 새 인메모리 저장소(탭 하나 = 저장소 하나).
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => { store.clear(); }, key: () => null, length: 0 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// 보드처럼: 패널을 열고 닫는 부모(onClose → 언마운트 · 다시 열기 → 새로 마운트).
async function render(story: KanbanStory | null, onClose: () => void = () => {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>{story ? <StoryDetailPanel key={story.id} story={story} tasks={[]} projectId="p1" onClose={onClose} /> : <p data-testid="board">보드</p>}</ToastProvider>
      </NextIntlClientProvider>,
    );
  });
}
const commentBox = () => container.querySelector(`textarea[placeholder="${koMessages.board.commentInputPlaceholder}"]`) as HTMLTextAreaElement | null;
const panelRoot = () => container.querySelector('[role="dialog"][tabindex="-1"]') as HTMLElement | null;
async function openCommentsTab() {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((t) => (t.textContent ?? '').startsWith(koMessages.board.comments));
  await act(async () => {
    tab!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    tab!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
async function type(text: string) {
  const box = commentBox()!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    box.focus();
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const esc = (target: EventTarget, init: KeyboardEventInit = {}) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })); });
const TYPED = '보내기 전 쓰던 댓글 — 사라지면 안 된다';

describe('StoryDetailPanel — 댓글 칸 Esc · 초안([SID:4369] 유나 규칙)', () => {
  it('② 글 있음: 첫 Esc = 칸에서만 빠져나옴(글 유지 · 초점 = 패널 뿌리) · 둘째 Esc = 닫힘', async () => {
    const onClose = vi.fn();
    await render(S1, onClose);
    await openCommentsTab();
    await type(TYPED);
    await esc(commentBox()!);
    expect(onClose).not.toHaveBeenCalled();
    expect(commentBox()?.value).toBe(TYPED);
    expect(document.activeElement).toBe(panelRoot());
    await esc(document.activeElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('③ 글 없음: 칸에서 Esc 한 번에 닫힘', async () => {
    const onClose = vi.fn();
    await render(S1, onClose);
    await openCommentsTab();
    await act(async () => { commentBox()!.focus(); });
    await esc(commentBox()!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('① 한글 조합 중 Esc = 조합만 취소(닫힘 0 · 초점 칸 그대로 · 글 그대로)', async () => {
    const onClose = vi.fn();
    await render(S1, onClose);
    await openCommentsTab();
    await type('한글 조합');
    await esc(commentBox()!, { isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(commentBox());
    expect(commentBox()?.value).toBe('한글 조합');
  });

  // ④ 닫는 길 넷 — 어느 길로 닫아도 같은 스토리를 다시 열면 초안이 그대로.
  const closers: Array<[string, () => Promise<void>]> = [
    ['Esc 두 번', async () => { await esc(commentBox()!); await esc(document.activeElement!); }],
    ['✕ 버튼', async () => { const x = [...container.querySelectorAll('button')].find((b) => b.textContent === '✕')!; await act(async () => { x.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }],
    ['바깥(배경) 누름', async () => { const bg = panelRoot()!.previousElementSibling as HTMLElement; await act(async () => { bg.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }],
  ];
  for (const [name, close] of closers) {
    it(`④ ${name}로 닫고 다시 열면 초안 그대로`, async () => {
      let open = true;
      const onClose = vi.fn(() => { open = false; });
      await render(S1, onClose);
      await openCommentsTab();
      await type(TYPED);
      await close();
      expect(onClose).toHaveBeenCalledTimes(1);
      await render(open ? S1 : null, onClose);
      await render(S1, onClose);
      await openCommentsTab();
      expect(commentBox()?.value).toBe(TYPED);
    });
  }

  it('④ 다른 스토리로 옮겼다 돌아오면 초안 그대로 · 다른 스토리 칸은 자기 것(빈 칸)', async () => {
    await render(S1);
    await openCommentsTab();
    await type(TYPED);
    await render(S2);
    await openCommentsTab();
    expect(commentBox()?.value).toBe('');
    await render(S1);
    await openCommentsTab();
    expect(commentBox()?.value).toBe(TYPED);
  });

  it('④ 보내기 성공 때만 초안을 지움 · 실패면 남음', async () => {
    await render(S1);
    await openCommentsTab();
    await type(TYPED);
    postOk = false;
    const send = () => [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.board.commentSubmit)!;
    await act(async () => { send().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await render(null);
    await render(S1);
    await openCommentsTab();
    expect(commentBox()?.value, '실패 → 남음').toBe(TYPED);
    postOk = true;
    await act(async () => { send().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await render(null);
    await render(S1);
    await openCommentsTab();
    expect(commentBox()?.value, '성공 → 지움').toBe('');
  });
});

// 유나 (가) — 초안 남은 설명/AC는 다시 열면 편집 모드로 초안 · «취소» = 초안 지우고 보기 모드 · 서버 글이 바뀌었어도 초안(합치기 없음).
describe('StoryDetailPanel — 설명 · AC 초안([SID:4369] 유나 (가))', () => {
  const S1D = { ...S1, description: '원래 설명', acceptance_criteria: '원래 AC' } as KanbanStory;
  const draftKey = (field: string) => `sprintable:field-draft:v1:u:-:story-panel:s1:${field}`; // story #4490 — owner segment (none set: -)
  const editorOf = (orig: string) => [...container.querySelectorAll('textarea')].find((t) => t.value.startsWith(orig)) ?? null;
  async function openEditor(label: string) {
    const head = [...container.querySelectorAll('span')].find((x) => x.textContent === label)!;
    const edit = [...head.parentElement!.querySelectorAll('button')].find((x) => /✎/.test(x.textContent ?? ''))!;
    await act(async () => { edit.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }
  async function typeInto(el: HTMLTextAreaElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { el.focus(); setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  for (const [name, orig, label, field] of [['설명', '원래 설명', koMessages.board.description, 'description'], ['AC', '원래 AC', koMessages.board.acceptanceCriteria, 'acceptance-criteria']] as const) {
    it(`${name}: 글 쓰고 Esc 두 번(칸 → 닫힘) → 다시 열면 편집 모드로 초안`, async () => {
      const onClose = vi.fn();
      await render(S1D, onClose);
      await openEditor(label);
      const typed = `${orig} 고쳐 쓴 문장`;
      await typeInto(editorOf(orig)!, typed);
      await esc(editorOf(orig)!);
      expect(editorOf(orig)?.value, '첫 Esc — 칸에서만(편집 · 글 그대로)').toBe(typed);
      await esc(document.activeElement!);
      expect(onClose).toHaveBeenCalledTimes(1);
      await render(null);
      await render(S1D, onClose);
      expect(editorOf(orig)?.value, '다시 열면 편집 모드 + 초안').toBe(typed);
    });

    it(`${name}: «취소» = 초안 지우고 보기 모드(키 없음) · 다시 열어도 보기 모드`, async () => {
      await render(S1D);
      await openEditor(label);
      await typeInto(editorOf(orig)!, `${orig} 버릴 문장`);
      expect(sessionStorage.getItem(draftKey(field))).not.toBeNull();
      const cancel = [...editorOf(orig)!.closest('div')!.parentElement!.querySelectorAll('button')].find((b) => b.textContent === koMessages.board.cancel)!;
      await act(async () => { cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(editorOf(orig), '보기 모드').toBeNull();
      expect(sessionStorage.getItem(draftKey(field))).toBeNull();
      await render(null);
      await render(S1D);
      expect(editorOf(orig), '다시 열어도 보기 모드').toBeNull();
    });

    it(`${name}: 저장 실패면 초안 남음 · 저장 성공 때만 지움`, async () => {
      let patchOk = false;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH' && String(url).includes('/api/stories/s1')) {
          const body = JSON.parse(String(init.body ?? '{}'));
          return patchOk ? new Response(JSON.stringify({ data: { ...S1D, ...body } }), { status: 200 }) : new Response('{}', { status: 500 });
        }
        return { ok: false, json: async () => null } as unknown as Response;
      }));
      await render(S1D);
      await openEditor(label);
      await typeInto(editorOf(orig)!, `${orig} 저장할 문장`);
      const save = () => [...editorOf(orig)!.closest('div')!.parentElement!.querySelectorAll('button')].find((b) => b.textContent === koMessages.board.save)!;
      await act(async () => { save().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(sessionStorage.getItem(draftKey(field)), '실패 → 남음').not.toBeNull();
      await openEditor(label);
      patchOk = true;
      await act(async () => { save().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(sessionStorage.getItem(draftKey(field)), '성공 → 지움').toBeNull();
    });

    it(`${name}: 그 사이 서버 글이 바뀌었어도 다시 열면 초안(합치기 없음)`, async () => {
      await render(S1D);
      await openEditor(label);
      const typed = `${orig} 내 초안`;
      await typeInto(editorOf(orig)!, typed);
      await render(null);
      const changed = { ...S1D, description: '남이 바꾼 설명', acceptance_criteria: '남이 바꾼 AC' } as KanbanStory;
      await render(changed);
      expect(editorOf(orig)?.value).toBe(typed);
    });
  }
});
