// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 조직 · piece ⑤a) — the organization card and its danger card on ds parts: the rename field (Enter saves, the button is held until the name is a new non-empty one, the error line is a field error), the read-only rows for a member,
// the loading skeleton named «불러오는 중…», and the owner's delete press reaching the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { OrgDangerSection, OrganizationSection, type OrganizationInfo } from './organization-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const ORG: OrganizationInfo = { id: 'o1', name: '문클랩스', slug: 'moonklabs', plan: 'pro' };
const t = koMessages.settings;
async function draw(node: React.ReactNode) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
}
const input = () => container.querySelector('input') as HTMLInputElement | null;
const saveBtn = () => [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.save) as HTMLButtonElement | undefined;
const props = (over: Partial<Parameters<typeof OrganizationSection>[0]> = {}) => ({ orgInfo: ORG, role: 'owner', name: '문클랩스', onNameChange: vi.fn(), onSave: vi.fn(), saving: false, nameError: null, ...over });

describe('[SID:4891] OrganizationSection on ds parts', () => {
  it('an owner/admin gets a labelled rename field (real label for) and [저장]; slug · plan · role are read-only rows with their names; the slug carries its «cannot change» hint', async () => {
    await draw(<OrganizationSection {...props()} />);
    expect(container.querySelector('[data-slot="ds-card"] h2')?.textContent).toBe(t.orgSectionTitle);
    expect(container.querySelector(`label[for="${input()!.id}"]`)?.textContent).toBe(t.profileName);
    expect(input()!.value).toBe('문클랩스');
    expect(container.textContent).toContain('moonklabs');
    expect(container.textContent).toContain(t.orgSlugImmutable);
    expect(container.textContent).toContain('pro');
    expect(container.textContent).toContain(t.orgMyRoleLabel);
    // the role is said with the canonical translated word (owner → 소유자), not the raw API value (verify:no-raw-role-jsx-text)
    expect(container.textContent).toContain(t.roleOwner);
    expect(container.textContent).not.toMatch(/(^|[^가-힣])owner([^가-힣]|$)/);
  });

  it('[저장] is held while the name is empty or unchanged or a save is out; a new name releases it; Enter and the press both call onSave', async () => {
    const p = props();
    await draw(<OrganizationSection {...p} />);
    expect(saveBtn()!.disabled).toBe(true); // unchanged
    await draw(<OrganizationSection {...p} name="   " />);
    expect(saveBtn()!.disabled).toBe(true); // empty
    await draw(<OrganizationSection {...p} name="새 이름" saving />);
    const busy = container.querySelector('button') as HTMLButtonElement; // while saving the word is «저장 중…»
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toBe(koMessages.common.saving);
    await draw(<OrganizationSection {...p} name="새 이름" />);
    expect(saveBtn()!.disabled).toBe(false);
    await act(async () => { saveBtn()!.click(); });
    expect(p.onSave).toHaveBeenCalledTimes(1);
    await act(async () => { input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(p.onSave).toHaveBeenCalledTimes(2);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '다른 이름');
      input()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(p.onNameChange).toHaveBeenCalledWith('다른 이름');
  });

  it('a save error is the field\'s error line (role=alert) tied to the input', async () => {
    await draw(<OrganizationSection {...props({ nameError: '이미 있는 이름이에요' })} />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('이미 있는 이름이에요');
    expect(input()!.getAttribute('aria-invalid')).toBe('true');
    expect(input()!.getAttribute('aria-describedby')).toBe(alert!.id);
  });

  it('a plain member sees the name read-only (no input, no button)', async () => {
    await draw(<OrganizationSection {...props({ role: 'member' })} />);
    expect(input()).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('문클랩스');
  });

  it('a plain member still sees a left-over rename error (the page keeps it across an organization switch) — as an alert under the name', async () => {
    await draw(<OrganizationSection {...props({ role: 'member', nameError: '이름을 바꾸지 못했어요' })} />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('이름을 바꾸지 못했어요');
    expect(input()).toBeNull();
  });

  it('while the organization is read: a named loading group (one voice) and no fields', async () => {
    await draw(<OrganizationSection {...props({ orgInfo: null })} />);
    const g = container.querySelector('[data-slot="ds-skeleton-group"]')!;
    expect(g.getAttribute('role')).toBe('status');
    expect(g.getAttribute('aria-label')).toBe(koMessages.common.loading);
    expect(g.querySelectorAll('[data-slot="ds-skeleton"]')).toHaveLength(3);
    expect(input()).toBeNull();
  });

  it('the danger card: the title is the failed colour, the warning is its description, and the danger button hands the press to the page', async () => {
    const open = vi.fn();
    await draw(<OrgDangerSection onOpenDelete={open} />);
    expect(container.querySelector('h2')?.textContent).toBe(t.dangerZone);
    expect(container.textContent).toContain(t.orgDeleteWarning);
    const btn = container.querySelector('button')!;
    expect(btn.textContent).toBe(t.orgDeleteTitle);
    expect(btn.className).toContain('border-ds-failed');
    await act(async () => { btn.click(); });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
