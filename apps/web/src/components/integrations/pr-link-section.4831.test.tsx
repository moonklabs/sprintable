// @vitest-environment jsdom
//
// story 4831 부품 교체(공용 부품 ④) — PR 연결 추가 줄의 저장소 · PR 번호 칸이 바탕 Input이 되어도 쓴 글이 요청 본문에 같은 모양으로 실린다.
// 구조: 전에는 «테두리 틀 + 앞글자(owner/ · #) + 투명 입력»이었고, 이제 틀의 테두리는 없고 Input이 테두리와 초점 링을 갖는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const { PrLinkSection } = await import('./pr-link-section');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.includes('/status')) return { ok: true, json: async () => ({ data: { connected: true, account_login: 'acme' } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const gh = koMessages.githubLinks as unknown as Record<string, string>;
function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const hasClass = (el: Element, token: string) => el.className.split(/\s+/).includes(token);

describe('PrLinkSection — 추가 줄의 바탕 부품(story 4831)', () => {
  it('저장소 · PR 번호 칸은 바탕 Input이고 틀의 테두리는 없다(앞글자는 칸 밖, Input이 테두리를 가짐)', async () => {
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><PrLinkSection storyId="s-1" /></NextIntlClientProvider>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const repo = container.querySelector(`input[aria-label="${gh.repoAria}"]`) as HTMLInputElement;
    const pr = container.querySelector(`input[aria-label="${gh.prAria}"]`) as HTMLInputElement;
    expect(repo.dataset.slot).toBe('ds-input');
    expect(pr.dataset.slot).toBe('ds-input');
    expect(hasClass(repo, 'flex-1')).toBe(true);
    expect(hasClass(repo, 'font-mono')).toBe(true);
    expect(hasClass(repo, 'text-ds-ink')).toBe(true);
    expect(hasClass(pr, 'w-20')).toBe(true);
    expect(hasClass(pr, 'text-ds-ink')).toBe(true);
    expect(pr.inputMode).toBe('numeric');
    for (const input of [repo, pr]) expect(input.parentElement!.className).not.toContain('border'); // 틀이 아니라 Input이 테두리를 가진다
    expect(repo.parentElement!.textContent).toContain('acme/'); // 앞글자
  });

  it('쓴 저장소 이름과 숫자만 남긴 PR 번호가 POST 본문(owner/repo · pr_number)에 실리고, 둘 다 쓰기 전엔 추가 단추가 잠긴다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><PrLinkSection storyId="s-1" /></NextIntlClientProvider>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const repo = container.querySelector(`input[aria-label="${gh.repoAria}"]`) as HTMLInputElement;
    const pr = container.querySelector(`input[aria-label="${gh.prAria}"]`) as HTMLInputElement;
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === gh.addCta) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await act(async () => { setValue(repo, ' web '); });
    expect(add.disabled).toBe(true); // 번호가 아직 없다
    await act(async () => { setValue(pr, '12a3'); });
    expect(pr.value).toBe('123'); // 숫자가 아닌 글자는 걸러진다
    expect(add.disabled).toBe(false);
    await act(async () => { add.click(); await Promise.resolve(); await Promise.resolve(); });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/integrations/github/links');
    expect(JSON.parse(String(init.body))).toEqual({ story_id: 's-1', repo_full_name: 'acme/web', pr_number: 123 });
  });

  it('⭐긴 설치 계정 이름이 속성 칸(16rem) 밖으로 안 나간다 — 앞글자는 줄어들고(min-w-0 truncate) 전체는 title에 있다(4908)', async () => {
    const LONG = 'a-very-long-github-installation-account-login-name-for-an-organisation';
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/status')) return { ok: true, json: async () => ({ data: { connected: true, account_login: LONG } }) };
      return { ok: true, json: async () => ({ data: [] }) };
    });
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><PrLinkSection storyId="s-1" /></NextIntlClientProvider>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const prefix = [...container.querySelectorAll('span')].find((n) => n.textContent === `${LONG}/`)!;
    expect(prefix, '계정 앞글자').toBeTruthy();
    expect(prefix.getAttribute('title')).toBe(LONG);
    for (const t of ['min-w-0', 'truncate']) expect(hasClass(prefix, t), t).toBe(true);
    expect(hasClass(prefix, 'shrink-0')).toBe(false);
  });
});
