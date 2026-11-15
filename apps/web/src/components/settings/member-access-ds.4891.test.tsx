// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 프로젝트 접근 · piece ⑤c) — what the move to ds parts added: names for the controls (the invite role select is «역할», the webhook address boxes say whose they are), the pressed state of the project chips, the roles of
// the result lines (success = status, failure = alert), the webhook card's save wiring, and no old `ui/` parts (data-slot) left on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProjectAccessSection } from './project-access-section';
import { AddMemberModal } from './add-member-modal';
import { MemberWebhooksSection } from './member-webhooks-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let postOk: boolean;
let inviteOk: boolean;
const T = koMessages.settings;

beforeEach(() => {
  postOk = true; inviteOk = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
    if (url === '/api/projects/p-1/access-candidates') return json([{ id: 'm-member', user_id: 'u-m', name: '구성원', email: 'm@x.com', role: 'member' }]);
    if (url === '/api/projects/p-1/access' && method === 'POST') return json({}, postOk ? 201 : 500);
    if (url === '/api/projects/p-1/access') return json([]);
    if (url === '/api/organizations/org-1/invites' && method === 'POST') return inviteOk ? json({ invite_url: 'u' }) : new Response('{}', { status: 500 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const wrap = (ui: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{ui}</NextIntlClientProvider>;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const btn = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('[SID:4891] ProjectAccessSection on ds parts', () => {
  async function draw() { await act(async () => { root.render(wrap(<ProjectAccessSection projectId="p-1" />)); }); await flush(); }

  it('the toggle is a ds secondary button while blocked; the result line is a status (success) or an alert (failure)', async () => {
    await draw();
    expect(btn(container, T.projectAccessBlocked).className).toContain('touch:min-h-ds-touch');
    postOk = false;
    await click(btn(container, T.projectAccessBlocked));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(T.projectAccessGrantFailed);
    postOk = true;
    await click(btn(container, T.projectAccessBlocked));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(koMessages.settings.projectMemberPutOn.replace('{name}', '구성원'));
  });

  it('draws no old ui/ part (data-slot) — card, tag, button are ds', async () => {
    await draw();
    const slots = [...container.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.filter((s) => !s.startsWith('ds-'))).toEqual([]);
  });
});

describe('[SID:4891] AddMemberModal on ds parts', () => {
  const projects = [{ id: 'p-1', name: '프로젝트 하나' }];
  async function drawModal() { await act(async () => { root.render(wrap(<AddMemberModal open onClose={() => {}} orgId="org-1" projects={projects} onAdded={() => {}} />)); }); await flush(); }

  it('the dialog is named by its title; the role select is named «역할»; the email box has a name', async () => {
    await drawModal();
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(T.addMember);
    expect(document.body.querySelector('select')?.getAttribute('aria-label')).toBe('역할');
    expect(document.body.querySelector('input[type="email"]')?.getAttribute('aria-label')).toBe(T.inviteEmailPlaceholder);
  });

  it('a project chip is pressed after a tap and un-pressed after a second tap', async () => {
    await drawModal();
    const chip = btn(document.body, '프로젝트 하나');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('a failed invite is spoken as an alert with the fixed words (no raw server text)', async () => {
    await drawModal();
    const email = document.body.querySelector('input[type="email"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(email, 'a@x.com'); email.dispatchEvent(new Event('input', { bubbles: true })); });
    inviteOk = false;
    await click([...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === T.addMember).pop()!);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(T.addMemberInviteError);
  });
});

describe('[SID:4891] MemberWebhooksSection on ds parts', () => {
  const rowLabels = new Map([['h-1', '지우'], ['h-2', '하나']]);
  function props(over: Partial<React.ComponentProps<typeof MemberWebhooksSection>> = {}) {
    return {
      members: [{ id: 'h-1' }, { id: 'h-2' }],
      webhooks: [{ member_id: 'h-1', url: 'https://hook.test/a', is_active: true }],
      editing: {}, errors: {}, savingId: null, rowLabels, onEdit: vi.fn(), onSave: vi.fn(), ...over,
    };
  }
  const draw = async (p: ReturnType<typeof props>) => { await act(async () => { root.render(wrap(<MemberWebhooksSection {...p} />)); }); await flush(); };

  it('each row shows its saved address (or empty), a status tag, and an address box named «웹훅 — 이름»', async () => {
    await draw(props());
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(['https://hook.test/a', '']);
    expect(inputs.map((i) => i.getAttribute('aria-label'))).toEqual([`${T.webhooks} — 지우`, `${T.webhooks} — 하나`]);
    // the [저장] buttons are identical words in every row: each carries its row number (story 3592 — «{n}번째 구성원 저장»)
    const saveNames = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(saveNames).toEqual(['1번째 구성원 저장', '2번째 구성원 저장']);
    expect(container.textContent).toContain(T.webhookStatusActive);
    expect(container.textContent).toContain(T.webhookStatusEmpty);
  });

  it('[저장] saves exactly that row; typing reports that row and the text; a draft wins over the saved address', async () => {
    const p = props({ editing: { 'h-1': 'https://draft.test/a2', 'h-2': 'https://draft.test/z' } }); // h-1 has a saved address AND a draft: the draft is what the box shows
    await draw(p);
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(['https://draft.test/a2', 'https://draft.test/z']);
    const saves = [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === koMessages.common.save);
    await click(saves[1]!);
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect(p.onSave).toHaveBeenCalledWith('h-2');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(inputs[0]!, 'https://hook.test/b'); inputs[0]!.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(p.onEdit).toHaveBeenCalledWith('h-1', 'https://hook.test/b');
  });

  it('the saving row’s button is disabled and shows «...»; an error is an alert under that row only', async () => {
    await draw(props({ savingId: 'h-1', errors: { 'h-2': '주소가 올바르지 않아요' } }));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[0]!.textContent).toBe('...');
    expect(buttons[1]!.disabled).toBe(false);
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe('주소가 올바르지 않아요');
  });
});
