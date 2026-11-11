// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings frame + four tabs) — the parts of the frame and the four panes that are not the project list: the two confirmations the page renders outside any tab (organization delete · project delete), the account danger card, the API-keys card
// and the settings list's selected row (no tint on a phone's full-screen list; the accessible «current» mark stays). The account-deletion window itself keeps its own test (`delete-account-dialog.4752.test.tsx`, unchanged).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import koMessages from '../../../messages/ko.json';
import { OrgDeleteDialog, type OrgDeleteDialogProps } from './org-delete-dialog';
import { ProjectDeleteDialog } from './project-delete-dialog';
import { AccountDangerSection } from './account-danger-section';
import { ApiKeysMovedCard } from './api-keys-moved-card';
import { SettingsNav } from '@/app/(authenticated)/settings/settings-nav-list';
import { settingsNavGroups } from '@/app/(authenticated)/settings/settings-nav';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/settings', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}?p=P` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.settings;
const C = koMessages.common;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { pushMock.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });

const draw = async (ui: React.ReactNode) => { await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{ui}</NextIntlClientProvider>); }); };
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const btn = (text: string, scope: ParentNode = document) => ([...scope.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === text)!;
const oldSlots = (scope: ParentNode) => [...scope.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-') && s !== 'dialog-overlay'); // the ds Dialog's overlay is the shared overlay part (named exemption)

function orgProps(over: Partial<OrgDeleteDialogProps> = {}): OrgDeleteDialogProps {
  return {
    orgName: '우리 조직', impact: { project_count: 2, member_count: 5, has_active_subscription: false }, impactLoading: false,
    confirmName: '', onConfirmName: vi.fn(), confirmWithoutImpact: false, onConfirmWithoutImpact: vi.fn(), deleting: false, canSubmit: false,
    onRetryImpact: vi.fn(), onClose: vi.fn(), onConfirm: vi.fn(), ...over,
  };
}

describe('[SID:4891] OrgDeleteDialog', () => {
  it('is named by its title; shows the impact counts (and the subscription line only when there is one); the name box has a visible name and the org name as its placeholder', async () => {
    await draw(<OrgDeleteDialog {...orgProps()} />);
    const d = dialog();
    expect(d.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe(T.orgDeleteTitle);
    expect(d.textContent).toContain(T.orgDeleteImpactTitle);
    expect(d.textContent).toContain('프로젝트 2개 영구 삭제');
    expect(d.textContent).not.toContain(T.orgDeleteImpactSubscription);
    const box = d.querySelector('input[type="text"], input:not([type])') as HTMLInputElement;
    expect((box.labels?.[0]?.textContent ?? '').trim()).toBe(T.orgDeleteConfirmPrompt.replace('{name}', '우리 조직'));
    expect(box.placeholder).toBe('우리 조직');
    await draw(<OrgDeleteDialog {...orgProps({ impact: { project_count: 1, member_count: 1, has_active_subscription: true } })} />);
    expect(dialog().textContent).toContain(T.orgDeleteImpactSubscription);
  });

  it('⭐the impact could not be read: a warning with «다시 시도» and an acknowledgement checkbox (with its audit line) — the button stays as the page decides', async () => {
    const p = orgProps({ impact: null });
    await draw(<OrgDeleteDialog {...p} />);
    const d = dialog();
    expect(d.textContent).toContain(T.orgDeleteImpactUnavailable);
    expect(d.textContent).toContain(T.orgDeleteWithoutImpact);
    expect(d.textContent).toContain(T.orgDeleteWithoutImpactAudit);
    await act(async () => { btn(C.retry, d).click(); });
    expect(p.onRetryImpact).toHaveBeenCalledTimes(1);
    const ack = d.querySelector('[role="checkbox"]') as HTMLElement;
    expect(ack.getAttribute('aria-checked')).toBe('false');
    await act(async () => { ack.click(); });
    expect(p.onConfirmWithoutImpact).toHaveBeenCalledWith(true);
    expect(btn(T.orgDeleteConfirmCta, d).disabled).toBe(true); // canSubmit is false: the page's rule decides
  });

  it('reading the impact shows placeholders (named «loading») and no warning; typing goes back; confirm follows canSubmit; deleting says so and locks cancel', async () => {
    await draw(<OrgDeleteDialog {...orgProps({ impact: null, impactLoading: true })} />);
    expect(dialog().querySelector('[aria-label="' + C.loading + '"], [role="status"]')).not.toBeNull();
    expect(dialog().textContent).not.toContain(T.orgDeleteImpactUnavailable);
    const p = orgProps({ canSubmit: true, confirmName: '우리 조직' });
    await draw(<OrgDeleteDialog {...p} />);
    const box = dialog().querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, '우');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(p.onConfirmName).toHaveBeenCalledWith('우');
    expect(btn(T.orgDeleteConfirmCta).disabled).toBe(false);
    await act(async () => { btn(T.orgDeleteConfirmCta).click(); });
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { btn(C.cancel).click(); });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    await draw(<OrgDeleteDialog {...orgProps({ canSubmit: true, deleting: true })} />);
    expect(btn(C.deleting).disabled).toBe(false); // the red button's label while deleting (the page's `canSubmit` keeps it locked there)
    expect(btn(C.cancel).disabled).toBe(true);
  });

  it('draws no old ui/ part', async () => {
    await draw(<OrgDeleteDialog {...orgProps({ impact: null })} />);
    expect(oldSlots(document)).toEqual([]);
  });
});

describe('[SID:4891] ProjectDeleteDialog', () => {
  it('is named by its title and says what deleting does; «취소» and the red button hand the presses back', async () => {
    const onClose = vi.fn(); const onConfirm = vi.fn();
    await draw(<ProjectDeleteDialog deleting={false} onClose={onClose} onConfirm={onConfirm} />);
    const d = dialog();
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe(T.projectDeleteConfirmTitle);
    expect(d.textContent).toContain(T.projectDeleteConfirmDesc);
    await act(async () => { btn(C.cancel, d).click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { btn(T.deleteProject, d).click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(oldSlots(document)).toEqual([]);
  });

  it('while deleting the red button is locked and shows «...»', async () => {
    await draw(<ProjectDeleteDialog deleting onClose={vi.fn()} onConfirm={vi.fn()} />);
    const red = ([...dialog().querySelectorAll('button')] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === '...')!;
    expect(red.disabled).toBe(true);
  });
});

describe('[SID:4891] the account danger card and the API-keys card', () => {
  it('the danger card keeps its words: the title, the one-line description, what deleting does; the red button asks the page to open the confirmation', async () => {
    const onOpen = vi.fn();
    await draw(<AccountDangerSection onOpenDelete={onOpen} />);
    expect(container.textContent).toContain(T.dangerZone);
    expect(container.textContent).toContain(T.dangerDescription);
    expect(container.textContent).toContain(T.deleteAccountDesc);
    await act(async () => { btn(T.deleteAccount, container).click(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(btn(T.deleteAccount, container).className).toContain('border-ds-failed'); // the ds danger button
    expect(oldSlots(container)).toEqual([]);
  });

  it('the API-keys card says where the keys moved (with its bold part) and its button goes to the agent management page with the project carried', async () => {
    await draw(<ApiKeysMovedCard />);
    expect(container.textContent).toContain(T.tabApiKeys);
    expect(container.querySelector('strong')?.textContent).toBe('에이전트 관리');
    await act(async () => { btn(T.agentManagementCta, container).click(); });
    expect(pushMock).toHaveBeenCalledWith('/organization/workforce?p=P');
    expect(oldSlots(container)).toEqual([]);
  });
});

describe('[SID:4891] the settings list: the selected row', () => {
  const groups = settingsNavGroups({ adminChecked: true, isAdmin: true, inPhoneApp: false, supportWidget: true, billing: false });
  async function drawNav(active: string) {
    await draw(<TabsPrimitive.Root value={active}><SettingsNav groups={groups} activeTab={active} integrationsHref="/settings/integrations" /></TabsPrimitive.Root>);
  }

  it('the active row is marked for assistive tech (aria-current) and tinted from the side-by-side layout (lg) up — below lg the list is the whole screen and tints nothing', async () => {
    await drawNav('projects');
    const rows = [...container.querySelectorAll('[data-settings-tab]')] as HTMLElement[];
    const active = rows.filter((r) => r.getAttribute('aria-current') === 'true');
    expect(active.map((r) => r.getAttribute('data-settings-tab'))).toEqual(['projects']);
    expect(active[0]!.className).toContain('bg-ds-surface-high');
    expect(active[0]!.className).toContain('max-lg:bg-transparent');
    for (const r of rows.filter((x) => x !== active[0])) expect(r.className).toContain('max-lg:bg-transparent'); // the class is on every tab row; only the active one has a tint to cancel
  });

  it('every section row of the four panes is in the list for an admin: 문의 · 프로젝트 · 계정 삭제 (and 워크플로 정책 for the next piece)', async () => {
    await drawNav('support');
    const ids = [...container.querySelectorAll('[data-settings-tab]')].map((r) => r.getAttribute('data-settings-tab'));
    expect(ids).toEqual(expect.arrayContaining(['support', 'projects', 'danger', 'workflow-policies']));
  });
});
