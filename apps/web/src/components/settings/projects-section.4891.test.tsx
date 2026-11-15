// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings frame + four tabs) — the project pane's list part on ds parts: what the screen shows (rows · the current tag · who sees edit / delete), the names of the controls (every row's press is named with its project;
// every box has a visible name), the result line's role (success = status, failure = alert), the «only a person sees delete» gate that stays fail-closed, and the hand-back of each press. The requests themselves are pinned one level up
// (`app/(authenticated)/settings/page.requests.4891.test.tsx` — the page owns them).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProjectsSection, type ProjectsSectionProps } from './projects-section';

const { ctxMock } = vi.hoisted(() => ({ ctxMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctxMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.settings;
const C = koMessages.common;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  ctxMock.mockReturnValue({ currentMemberType: 'human' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

const projects = [{ id: 'p1', name: '알파', description: '첫째 프로젝트' }, { id: 'p2', name: '아주 긴 이름의 베타 프로젝트', description: null }];
function props(over: Partial<ProjectsSectionProps> = {}): ProjectsSectionProps {
  return {
    projects, currentProjectId: 'p1', isAdmin: true, editingId: null, editName: '', editDescription: '', saving: false,
    onEditStart: vi.fn(), onEditName: vi.fn(), onEditDescription: vi.fn(), onEditSave: vi.fn(), onEditCancel: vi.fn(),
    deletingId: null, onDeleteAsk: vi.fn(), message: null, newName: '', newDescription: '', creating: false,
    onNewName: vi.fn(), onNewDescription: vi.fn(), onCreate: vi.fn(), ...over,
  };
}
async function draw(p: ProjectsSectionProps) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ProjectsSection {...p} /></NextIntlClientProvider>); });
}
const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
const byName = (name: string) => buttons().find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);

describe('[SID:4891] ProjectsSection', () => {
  it('lists every project with its description, the current one tagged; an empty list says so', async () => {
    await draw(props());
    const list = container.querySelector('[data-testid="settings-projects-list"]')!;
    expect(list.textContent).toContain('알파');
    expect(list.textContent).toContain('첫째 프로젝트');
    expect(list.textContent).toContain('아주 긴 이름의 베타 프로젝트');
    expect(list.textContent?.split(T.currentProjectBadge).length).toBe(2); // the tag once
    await draw(props({ projects: [] }));
    expect(container.querySelector('[data-testid="settings-projects-list"]')).toBeNull();
    expect(container.textContent).toContain(T.projectListEmpty);
  });

  it('every row press is named with its project (the visible word first); a non-admin has no edit and no delete', async () => {
    await draw(props());
    expect(byName(`${C.edit} — 알파`)?.textContent?.trim()).toBe(C.edit);
    expect(byName(`${T.deleteProject} — 알파`)?.textContent?.trim()).toBe(T.deleteProject);
    expect(byName(`${C.edit} — 아주 긴 이름의 베타 프로젝트`)).toBeDefined();
    await draw(props({ isAdmin: false }));
    expect(buttons().filter((b) => b.textContent?.trim() === C.edit || b.textContent?.trim() === T.deleteProject)).toEqual([]);
    expect(container.textContent).toContain('알파'); // the list is still there for a member
    expect(byName(T.createProjectAction)).toBeDefined(); // and so is the create form (any member may create — story #4897)
  });

  it('⭐delete is drawn only for a person (fail-closed: an agent, or an unknown caller, never sees it) — edit stays', async () => {
    for (const memberType of ['agent', undefined]) {
      ctxMock.mockReturnValue({ currentMemberType: memberType });
      await draw(props());
      expect(byName(`${T.deleteProject} — 알파`), `member type ${String(memberType)}`).toBeUndefined();
      expect(byName(`${C.edit} — 알파`)).toBeDefined();
    }
    ctxMock.mockReturnValue({ currentMemberType: 'human' });
    await draw(props());
    expect(byName(`${T.deleteProject} — 알파`)).toBeDefined();
  });

  it('the presses go back to the page: edit start (with the row) · delete ask (with the id) · create', async () => {
    const p = props({ newName: '감마' });
    await draw(p);
    await act(async () => { byName(`${C.edit} — 알파`)!.click(); });
    expect(p.onEditStart).toHaveBeenCalledWith(projects[0]);
    await act(async () => { byName(`${T.deleteProject} — 알파`)!.click(); });
    expect(p.onDeleteAsk).toHaveBeenCalledWith('p1');
    await act(async () => { byName(T.createProjectAction)!.click(); });
    expect(p.onCreate).toHaveBeenCalledTimes(1);
  });

  it('create is off with an empty (or blank) name, and while creating; delete is off while that row is deleting', async () => {
    await draw(props());
    expect(byName(T.createProjectAction)!.disabled).toBe(true);
    await draw(props({ newName: '   ' }));
    expect(byName(T.createProjectAction)!.disabled).toBe(true);
    await draw(props({ newName: '감마' }));
    expect(byName(T.createProjectAction)!.disabled).toBe(false);
    await draw(props({ newName: '감마', creating: true }));
    expect(byName(T.createProjectAction)!.disabled).toBe(true);
    await draw(props({ deletingId: 'p2' }));
    expect(byName(`${T.deleteProject} — 아주 긴 이름의 베타 프로젝트`)!.disabled).toBe(true);
    expect(byName(`${T.deleteProject} — 알파`)!.disabled).toBe(false);
  });

  it('the row being edited shows two named boxes with the drafts, «저장» (off while the name is blank or saving) and «취소»', async () => {
    const p = props({ editingId: 'p1', editName: '알파 둘', editDescription: '설명' });
    await draw(p);
    // the same two words stand on every row that can be edited: each press is named with its project (the visible word first)
    expect(buttons().find((b) => b.getAttribute('aria-label') === `${C.save} — 알파`)?.textContent?.trim()).toBe(C.save);
    expect(buttons().find((b) => b.getAttribute('aria-label') === `${C.cancel} — 알파`)?.textContent?.trim()).toBe(C.cancel);
    const boxes = [...container.querySelectorAll('input')] as HTMLInputElement[];
    const named = (n: string) => boxes.filter((i) => (i.labels?.[0]?.textContent ?? '').trim() === n);
    expect(named(T.projectNamePlaceholder).map((i) => i.value)).toEqual(['알파 둘', '']); // the edit box, then the «new project» box
    expect(named(T.projectDescriptionPlaceholder).map((i) => i.value)).toEqual(['설명', '']);
    expect(boxes.every((i) => (i.labels?.length ?? 0) > 0)).toBe(true); // no unnamed box
    expect(byName(C.save)!.disabled).toBe(false);
    await act(async () => { byName(C.save)!.click(); });
    expect(p.onEditSave).toHaveBeenCalledTimes(1);
    await act(async () => { byName(C.cancel)!.click(); });
    expect(p.onEditCancel).toHaveBeenCalledTimes(1);
    await draw(props({ editingId: 'p1', editName: ' ' }));
    expect(byName(C.save)!.disabled).toBe(true);
    await draw(props({ editingId: 'p1', editName: '알파', saving: true }));
    expect(byName(C.save)!.disabled).toBe(true);
    // typing goes back to the page
    const q = props({ editingId: 'p1', editName: '알파' });
    await draw(q);
    const editBox = [...container.querySelectorAll('input')][0] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(editBox, '새 이름');
      editBox.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q.onEditName).toHaveBeenCalledWith('새 이름');
  });

  it('the result line: a success is a status, a failure an alert (read out the moment it appears)', async () => {
    await draw(props({ message: { type: 'success', text: '프로젝트를 삭제했어요.' } }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('프로젝트를 삭제했어요.');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await draw(props({ message: { type: 'error', text: '실패했어요' } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('실패했어요');
  });

  it('draws no old ui/ part (data-slot): card, tag, buttons, boxes are ds', async () => {
    await draw(props({ editingId: 'p1', editName: '알파', message: { type: 'error', text: 'x' } }));
    const slots = [...container.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!);
    expect(slots.length).toBeGreaterThan(5);
    expect(slots.filter((s) => !s.startsWith('ds-'))).toEqual([]);
  });
});
