// @vitest-environment jsdom
//
// story #4752 — «계정 삭제» 확인창. 전에는 REAUTHENTICATION_REQUIRED 말고 모든 실패(403 · 500 · 네트워크)에서 말 없이 닫혀, 눌렀는데 지워졌는지 알 수 없었다.
// 지금은 실패마다 이유 한 줄이 뜨고 창은 열려 있다(다시 시도 가능) · 성공(200)과 «이미 없음»(404)만 로그인 화면으로 나간다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { DeleteAccountDialog } from './delete-account-dialog';

// the call goes through fetchWithAuth (CI guard: no new raw fetch('/api/*')); this test hands it the answers
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
// flat destinations carry the project: the hook is the app's own (it needs the dashboard context), here it appends `p=P` so a link that skips it is seen
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=P` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onDeleted = vi.fn();

beforeEach(() => {
  previewAnswer = async () => ({ ok: true, status: 200, json: async () => ({ data: { closing: [], blocked: [] } }) });
  onClose.mockReset();
  onDeleted.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  fetchWithAuthMock.mockReset();
});

async function mount(locale: 'ko' | 'en' = 'ko') {
  route(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <DeleteAccountDialog onClose={onClose} onDeleted={onDeleted} />
      </NextIntlClientProvider>,
    );
  });
}

const confirmButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="delete-account-confirm"]')!;
const errorLine = () => document.body.querySelector('[data-testid="delete-account-error"]');

let previewAnswer: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ data: { closing: [], blocked: [] } }) });
const previewOf = (closing: unknown[], blocked: unknown[]) => { previewAnswer = async () => ({ ok: true, status: 200, json: async () => ({ data: { closing, blocked } }) }); };

function route(deleteAnswer: () => Promise<unknown>) {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation((url: string) => (String(url).includes('delete-preview') ? previewAnswer() : deleteAnswer()));
}

async function press(response: () => Promise<unknown>) {
  route(response);
  await act(async () => { confirmButton().click(); });
  await act(async () => { await Promise.resolve(); });
}

const answer = (status: number, body?: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} });

describe('[SID:4752] the delete-account confirmation says what happened', () => {
  it('⭐a 500 leaves the dialog open with «삭제하지 못했어요» and the button usable again (was: closed without a word)', async () => {
    await mount();
    await press(answer(500, { error: { code: 'INTERNAL' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteFailed);
    expect(confirmButton().disabled).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('⭐a 403 that is not a re-login request, and a network error, say the same «삭제하지 못했어요»', async () => {
    await mount();
    await press(answer(403, { error: { code: 'FORBIDDEN' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteFailed);
    await press(async () => { throw new Error('offline'); });
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteFailed);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('⭐REAUTHENTICATION_REQUIRED says to sign in again (in the dialog, not a browser alert)', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    await mount();
    await press(answer(403, { error: { code: 'REAUTHENTICATION_REQUIRED' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.reauthRequired);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('⭐a 401 says the session is over', async () => {
    await mount();
    await press(answer(401, { error: { code: 'UNAUTHORIZED' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteSessionEnded);
  });

  it('⭐200 leaves for the login page; no error line (the button stays locked while the page changes)', async () => {
    await mount();
    await press(answer(200, { ok: true }));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(errorLine()).toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });

  it('⭐404 (no such live account — already deleted) leaves for the login page too', async () => {
    await mount();
    await press(answer(404));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(errorLine()).toBeNull();
  });

  it('⭐the window shows what is deleted with the account before «삭제 확인», and the button stays usable', async () => {
    previewOf([{ id: 'o1', name: '혼자 쓰는 조직' }, { id: 'o2', name: '또 하나' }], []);
    await mount();
    expect(document.body.querySelector('[data-testid="delete-account-closing-orgs"]')?.textContent).toBe('함께 삭제되는 조직: 혼자 쓰는 조직, 또 하나 — 조직의 에이전트 · 프로젝트 · 데이터도 함께 제거돼요');
    expect(document.body.querySelector('[data-testid="delete-account-blocking-orgs"]')).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });

  it('⭐the English line names the agents too (what a person deleting the account must know first: their agents go with the organization)', async () => {
    previewOf([{ id: 'o1', name: 'Solo Org' }], []);
    await mount('en');
    expect(document.body.querySelector('[data-testid="delete-account-closing-orgs"]')?.textContent).toBe('Organizations deleted with it: Solo Org — their agents, projects and data are removed too');
  });

  it('⭐a populated organization where the person is the only owner blocks: named, with the way to the members screen, and «삭제 확인» is off', async () => {
    previewOf([], [{ id: 'o1', name: '둘이 쓰는 조직', reason: 'other_members' }]);
    await mount();
    const box = document.body.querySelector('[data-testid="delete-account-blocking-orgs"]')!;
    expect([...box.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['둘이 쓰는 조직 · 다른 구성원이 있어요 — 다른 소유자를 정하거나 조직을 삭제해 주세요']);
    expect([...box.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/organization/members?p=P']);
    expect(box.textContent).toContain(koMessages.settings.deleteOwnedOrgsTitle);
    expect(confirmButton().disabled).toBe(true);
  });

  it('⭐an organization that would close but has an active subscription blocks too: «먼저 구독을 해지», with the way to billing', async () => {
    previewOf([], [{ id: 'o1', name: '유료 조직', reason: 'active_subscription' }, { id: 'o2', name: '둘이 쓰는 조직', reason: 'other_members' }]);
    await mount();
    const box = document.body.querySelector('[data-testid="delete-account-blocking-orgs"]')!;
    expect([...box.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '유료 조직 · 활성 구독이 있어요 — 먼저 구독을 취소해 주세요',
      '둘이 쓰는 조직 · 다른 구성원이 있어요 — 다른 소유자를 정하거나 조직을 삭제해 주세요',
    ]);
    expect([...box.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/organization/members?p=P', '/settings?tab=billing&p=P']);
  });

  it('⭐every link out closes the dialog (the billing one stays on the same settings page)', async () => {
    previewOf([], [{ id: 'o1', name: 'A', reason: 'active_subscription' }, { id: 'o2', name: 'B', reason: 'other_members' }]);
    await mount();
    const links = [...document.body.querySelectorAll<HTMLAnchorElement>('[data-testid="delete-account-blocking-orgs"] a')];
    expect(links).toHaveLength(2);
    for (const [i, a] of links.entries()) {
      await act(async () => { a.click(); });
      expect(onClose).toHaveBeenCalledTimes(i + 1);
    }
  });

  it('a preview that cannot be read shows nothing and does not stop the deletion — the server judges', async () => {
    previewAnswer = async () => { throw new Error('offline'); };
    await mount();
    expect(document.body.querySelector('[data-testid="delete-account-closing-orgs"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="delete-account-blocking-orgs"]')).toBeNull();
    expect(errorLine()).toBeNull();   // an unreadable preview is not an error line
    expect(confirmButton().disabled).toBe(false);
    await press(answer(200, { ok: true }));
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('⭐a stale preview: the server answers 409 ORG_BLOCKS_ACCOUNT_DELETE with the list → the window shows it, stays open and turns «삭제 확인» off', async () => {
    await mount();
    await press(answer(409, { error: { code: 'ORG_BLOCKS_ACCOUNT_DELETE', orgs: [{ id: 'o1', name: '새로 생긴 조직', reason: 'other_members' }] } }));
    expect(document.body.querySelector('[data-testid="delete-account-blocking-orgs"] li')?.textContent).toContain('새로 생긴 조직');
    expect(onDeleted).not.toHaveBeenCalled();
    expect(confirmButton().disabled).toBe(true);
  });

  it('⭐a stale preview that listed an organization as closing and the server now blocks: it moves out of the «deleted with it» line', async () => {
    previewOf([{ id: 'o1', name: '곧 막힐 조직' }, { id: 'o2', name: '그대로 닫힐 조직' }], []);
    await mount();
    await press(answer(409, { error: { code: 'ORG_BLOCKS_ACCOUNT_DELETE', orgs: [{ id: 'o1', name: '곧 막힐 조직', reason: 'other_members' }] } }));
    const closing = document.body.querySelector('[data-testid="delete-account-closing-orgs"]')?.textContent ?? '';
    expect(closing).toContain('그대로 닫힐 조직');
    expect(closing).not.toContain('곧 막힐 조직');
    expect(document.body.querySelector('[data-testid="delete-account-blocking-orgs"]')?.textContent).toContain('곧 막힐 조직');
  });

  it('a 409 with no organization list is the generic «삭제하지 못했어요»', async () => {
    await mount();
    await press(answer(409, { error: { code: 'CONFLICT' } }));
    expect(errorLine()?.textContent).toBe(koMessages.settings.deleteFailed);
    expect(document.body.querySelector('[data-testid="delete-account-blocking-orgs"]')).toBeNull();
  });

  it('a failure then a retry that succeeds clears the line', async () => {
    await mount();
    await press(answer(500));
    expect(errorLine()).not.toBeNull();
    await press(answer(200, { ok: true }));
    expect(errorLine()).toBeNull();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('the English copy exists and states the immediate sign-out (no «permanently deleted»)', async () => {
    await mount('en');
    await press(answer(500));
    expect(errorLine()?.textContent).toBe(enMessages.settings.deleteFailed);
    expect(document.body.textContent).toContain('signed out of every device right away and cannot sign in again');
    expect(document.body.textContent).not.toMatch(/permanently/i);
  });

  it('the Korean copy says «바로 로그아웃» and «익명화» — not «영구 삭제» (what the 30-day job really does)', () => {
    expect(koMessages.settings.deleteConfirmDesc).toContain('로그아웃');
    expect(koMessages.settings.deleteConfirmDesc).toContain('익명화');
    expect(koMessages.settings.deleteConfirmDesc).toContain('다시 로그인할 수 없으며');   // the point of «cannot be undone» is on the confirm button's own window (유나)
    expect(koMessages.settings.deleteSessionEnded).toContain('세션이 만료됐어요');       // the product's word for it, not «로그인이 끝났어요» (which also reads «login done»)
    expect(koMessages.settings.deleteConfirmDesc).not.toContain('영구 삭제');
    expect(koMessages.settings.deleteAccountDesc).toContain('다시 로그인할 수 없어요');
  });
});
