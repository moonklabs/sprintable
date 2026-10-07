// @vitest-environment jsdom
//
// story #4548 — the web confirmation that turns on remote control for an already set-up computer (Yuna's «4548 서버 코드 ↔ 사람
// 문구» table · contract 02d2cf71 §1.1): the code is read from `#code=`, taken off the address at once and sent in bodies only;
// the computer's name and org show only when the server gave them (never on `not_org_admin`); each closed code has its line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => href }));
const { DesktopRemoteConfirm } = await import('./desktop-remote-confirm');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'c'.repeat(43);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string) => json(status, { data: null, error: { code, message: code }, meta: null });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchWithAuth.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  window.history.replaceState(null, '', '/');
});

async function open(hash: string, locale: 'ko' | 'en' = 'ko') {
  window.history.replaceState(null, '', `/desktop/remote${hash}`);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <DesktopRemoteConfirm />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const text = () => container.textContent ?? '';
const spoken = () => Array.from(container.querySelectorAll('[role="status"]')).map((e) => e.textContent).join(' | ');
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label))!;

describe('DesktopRemoteConfirm (story #4548)', () => {
  it('without a code it asks to open the page from the desktop app and calls nothing', async () => {
    await open('');
    expect(text()).toBe('데스크톱 앱에서 [이 컴퓨터에서 켜기]를 눌러 이 화면을 열어 주세요');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('reads the code off the address at once, shows the computer and org, and turns on with the code in the body only', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { device_name: 'SYJ-MacBook-Pro', org_name: '문클랩스', expires_at: '2026-10-03T09:00:00Z' }));
    await open(`#code=${CODE}`);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(CODE);
    expect(text()).toContain('이 컴퓨터에서 원격 제어를 켤까요?');
    expect(text()).toContain('SYJ-MacBook-Pro · 문클랩스');
    expect(text()).toContain('이 컴퓨터의 에이전트는 그대로예요 — 새로 만들지 않아요.');
    expect(fetchWithAuth.mock.calls[0]).toEqual(['/api/desktop/device-token-codes/peek', expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: CODE }) })]);

    fetchWithAuth.mockResolvedValueOnce(json(200, { setup_id: 's' }));
    await act(async () => { button('켜기').click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth.mock.calls[1]).toEqual(['/api/desktop/device-token-codes/confirm', expect.objectContaining({ body: JSON.stringify({ code: CODE }) })]);
    expect(fetchWithAuth.mock.calls.every(([url]) => !String(url).includes(CODE))).toBe(true);
    expect(text()).toBe('켰어요 — 데스크톱 앱으로 돌아가면 «원격 제어 켜짐»으로 바뀌어 있어요. 이 창은 닫아도 돼요.');
    expect(spoken()).toBe('켰어요 — 데스크톱 앱으로 돌아가면 «원격 제어 켜짐»으로 바뀌어 있어요. 이 창은 닫아도 돼요.');
    expect(document.activeElement?.getAttribute('role')).toBe('status'); // the button is gone — focus is on the result (Yuna 10:28Z)
    expect(document.activeElement?.textContent).toBe('켰어요 — 데스크톱 앱으로 돌아가면 «원격 제어 켜짐»으로 바뀌어 있어요. 이 창은 닫아도 돼요.');
  });

  it('cancel sends nothing and goes to «연결된 기기»', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { device_name: 'mac', org_name: 'org', expires_at: 'x' }));
    await open(`#code=${CODE}`);
    const cancel = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '취소')!;
    expect(cancel.getAttribute('href')).toBe('/desktop');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1); // the peek only
  });

  it('someone who may not turn it on sees «켤 수 없어요» and no computer or org name', async () => {
    fetchWithAuth.mockResolvedValueOnce(err(403, 'not_org_admin'));
    await open(`#code=${CODE}`);
    expect(text()).toBe('원격 제어를 켤 수 없어요이 컴퓨터의 원격 제어는 이 조직의 소유자 · 관리자만 켤 수 있어요');
    expect(spoken()).toBe('이 컴퓨터의 원격 제어는 이 조직의 소유자 · 관리자만 켤 수 있어요');
    expect(document.activeElement).toBe(document.body); // the first read moves no focus
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([
    ['code_expired', 410, '시간이 지났어요 — 데스크톱 앱에서 [이 컴퓨터에서 켜기]를 다시 눌러 주세요.'],
    ['code_used', 410, '이 링크는 더 쓸 수 없어요 — 데스크톱 앱에서 [이 컴퓨터에서 켜기]를 다시 눌러 주세요'],
    ['code_not_found', 404, '이 링크는 더 쓸 수 없어요 — 데스크톱 앱에서 [이 컴퓨터에서 켜기]를 다시 눌러 주세요'],
    ['remote_control_off', 409, '이 조직은 원격 제어가 꺼져 있어 이 컴퓨터를 켤 수 없어요 — 조직 소유자가 켜면 다시 할 수 있어요'], // story #4535 · 4583 (no org read here: no names)
  ])('%s reads its own line', async (code, status, line) => {
    fetchWithAuth.mockResolvedValueOnce(err(status, code));
    await open(`#code=${CODE}`);
    expect(text()).toBe(line);
    expect(spoken()).toBe(line); // heard by a screen reader too (Yuna 10:26Z)
  });

  it('a device disconnected between the peek and the press says so, with the way to «연결된 기기»', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { device_name: 'mac', org_name: 'org', expires_at: 'x' }));
    await open(`#code=${CODE}`);
    fetchWithAuth.mockResolvedValueOnce(err(409, 'setup_disconnected'));
    await act(async () => { button('켜기').click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('그 사이 이 컴퓨터의 연결이 끊겨 원격 제어를 켤 수 없어요');
    expect(spoken()).toContain('그 사이 이 컴퓨터의 연결이 끊겨 원격 제어를 켤 수 없어요');
    expect(document.activeElement?.getAttribute('role')).toBe('status'); // the result paragraph itself, not the page
    expect(document.activeElement?.textContent).toContain('그 사이 이 컴퓨터의 연결이 끊겨 원격 제어를 켤 수 없어요');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/desktop');
  });

  it('a network or server failure offers to try again, and trying again asks once more', async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    await open(`#code=${CODE}`);
    expect(text()).toContain('켜지 못했어요 — 잠시 뒤 다시 눌러 주세요');
    expect(spoken()).toBe('켜지 못했어요 — 잠시 뒤 다시 눌러 주세요');
    fetchWithAuth.mockResolvedValueOnce(json(200, { device_name: 'mac', org_name: 'org', expires_at: 'x' }));
    await act(async () => { button('다시 시도').click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(text()).toContain('mac · org');
  });

  it('en', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { device_name: 'mac', org_name: 'org', expires_at: 'x' }));
    await open(`#code=${CODE}`, 'en');
    expect(text()).toContain('Turn on remote control for this computer?');
    expect(text()).toContain("This computer's agents stay as they are — no new agents are created.");
  });
});
