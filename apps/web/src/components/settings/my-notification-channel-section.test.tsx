// @vitest-environment jsdom
//
// story #3519(§16-7 2부, PO 確定 2026-09-05) — projRes만 격리(.catch)돼 있고 meRes는
// 안 돼 있었다. meRes가 네트워크단 reject하면 Promise.all 전체가 던져(destructuring
// 자체가 실패) 이미 정상 응답한 projRes의 결과(nameMap)까지 못 반영됐을 뿐 아니라,
// 호출부가 `void load()`(fire-and-forget, .catch 없음)라 그 예외가 처리되지 않은
// promise rejection으로 새 나갔다 — 브라우저 전역 unhandledrejection(에러 모니터링
// 노이즈)로 이어지는 클래스. 한쪽만 격리하면 격리 자체가 무의미해진다는 걸 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { MyNotificationChannelSection } from './my-notification-channel-section';

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: addToastMock }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('MyNotificationChannelSection — meRes/projRes 격리(story #3519)', () => {
  it('/api/me가 네트워크 reject해도 처리되지 않은 promise rejection이 새지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') throw new Error('network down');
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '프로젝트 A' }] }) };
      return { ok: false, json: async () => null };
    }));

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await act(async () => {
        root.render(wrap(<MyNotificationChannelSection projectId="proj-1" projectName="프로젝트 A" />));
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      // 마이크로태스크 큐가 완전히 비워질 시간을 한 틱 더 준다(unhandledRejection은
      // 콜스택이 완전히 비고 난 뒤 다음 틱에 발화한다).
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

// story 4891 (UI-8 · settings › profile ②) — the card moved onto ds parts; these pin what its handlers DO (the same on the old markup and the new): a press that became a no-op would fail here.
describe('MyNotificationChannelSection — the handlers (same on old and new markup)', () => {
  type Hook = { id: string; member_id: string; url: string; project_id: string | null; is_active: boolean };
  let hooks: Hook[];
  let calls: { url: string; method: string; body?: Record<string, unknown> }[];
  let testSendBody: unknown;
  let rawBodies: Record<string, unknown>;

  beforeEach(() => {
    addToastMock.mockClear();
    calls = [];
    rawBodies = {};
    testSendBody = { data: { reached: true, ts: '2026-11-11T00:00:00Z' } };
    hooks = [
      { id: 'w-global', member_id: 'm-me', url: 'https://hooks.example.com/g', project_id: null, is_active: true },
      { id: 'w-cur', member_id: 'm-me', url: 'https://hooks.example.com/cur', project_id: 'proj-1', is_active: false },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      rawBodies[`${method} ${url}`] = init?.body;
      calls.push({ url, method, body: init?.body && init.body !== '{}' ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { id: 'm-me' } }) };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [{ id: 'proj-1', name: '프로젝트 A' }] }) };
      if (url === '/api/webhooks/config' && method === 'GET') return { ok: true, json: async () => ({ data: hooks.map((h) => ({ ...h })) }) }; // a fresh array each time, like a server
      if (url === '/api/webhooks/config' && method === 'PUT') {
        const b = JSON.parse(String(init!.body)) as Hook;
        const i = hooks.findIndex((h) => h.project_id === b.project_id && h.url === b.url);
        if (i >= 0) hooks[i] = { ...hooks[i]!, is_active: b.is_active }; else hooks.push({ ...b, id: `w-${hooks.length}` });
        return { ok: true, json: async () => ({ data: {} }) };
      }
      if (url.startsWith('/api/webhooks/config?id=') && method === 'DELETE') {
        hooks = hooks.filter((h) => `/api/webhooks/config?id=${h.id}` !== url);
        return { ok: true, json: async () => ({}) };
      }
      if (url.endsWith('/test-send')) return { ok: true, json: async () => testSendBody };
      return { ok: false, json: async () => null };
    }));
  });

  const flush = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); }); };
  async function draw() {
    await act(async () => { root.render(wrap(<MyNotificationChannelSection projectId="proj-1" projectName="프로젝트 A" />)); });
    await flush();
  }
  const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLElement;
  const press = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
  const tm = koMessages.settings;

  it('test-send POSTs the row\'s own address and says whether it reached (status line with the time)', async () => {
    await draw();
    await press(byLabel(`${tm.testSend} — ${tm.webhookScopeGlobal}`));
    expect(calls.find((c) => c.url === '/api/webhooks/config/w-global/test-send')?.method).toBe('POST');
    expect(rawBodies['POST /api/webhooks/config/w-global/test-send']).toBe('{}'); // the route expects a JSON body, empty object
    const line = container.querySelector('[role="status"][aria-live="polite"]');
    expect(line?.textContent).toContain(tm.testReached);
  });

  it('the switch PUTs the whole row with is_active flipped, and the switch follows the refetched list', async () => {
    await draw();
    const sw = byLabel(`${tm.webhookEnabledToggle} — 프로젝트 A`);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await press(sw);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ member_id: 'm-me', url: 'https://hooks.example.com/cur', project_id: 'proj-1', is_active: true });
    expect(byLabel(`${tm.webhookEnabledToggle} — 프로젝트 A`).getAttribute('aria-checked')).toBe('true');
  });

  it('delete asks first (Cancel has the focus, nothing is sent), Cancel leaves the row, Delete sends DELETE ?id= and the row goes', async () => {
    await draw();
    await press(byLabel(`${koMessages.common.delete} — 프로젝트 A`));
    const confirm = container.querySelector(`[role="group"][aria-label^="${tm.webhookDeleteConfirm}"]`);
    expect(confirm).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const [cancel, del] = [...confirm!.querySelectorAll('button')];
    expect(document.activeElement).toBe(cancel);
    await press(cancel!);
    expect(container.querySelector(`[role="group"][aria-label^="${tm.webhookDeleteConfirm}"]`)).toBeNull();
    expect(byLabel(`${tm.webhookEnabledToggle} — 프로젝트 A`)).toBeTruthy();
    await press(byLabel(`${koMessages.common.delete} — 프로젝트 A`));
    await press([...container.querySelectorAll(`[role="group"][aria-label^="${tm.webhookDeleteConfirm}"] button`)][1]!);
    void del;
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/webhooks/config?id=w-cur');
    expect(container.querySelector(`[aria-label="${tm.webhookEnabledToggle} — 프로젝트 A"]`)).toBeNull();
  });

  it('«현재 프로젝트 웹훅 추가/편집» prefills the current project\'s address and Save PUTs it with the row\'s on/off kept; an http address outside the local ranges is refused with a toast', async () => {
    await draw();
    const input = container.querySelector(`input[aria-label="${tm.webhookAddCurrentProject}"]`) as HTMLInputElement;
    expect(input.value).toBe('https://hooks.example.com/cur');
    const setValue = async (v: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.save)!;
    await setValue('http://example.com/not-local');
    await press(save);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(addToastMock).toHaveBeenCalledWith({ type: 'error', title: tm.webhookUrlInvalid });
    await setValue('https://hooks.example.com/new');
    await press(save);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ member_id: 'm-me', url: 'https://hooks.example.com/new', project_id: 'proj-1', is_active: false });
    expect(addToastMock).toHaveBeenCalledWith({ type: 'success', title: tm.webhookUrlSavedToast });
  });

  it('«전역 웹훅이 켜져 있어요» warns while a global address is on, and «글로벌 끄기 →» PUTs it off with project_id null', async () => {
    await draw();
    expect(container.textContent).toContain(tm.misconfigGlobalActive);
    const off = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(tm.turnOffGlobal))!;
    await press(off);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ member_id: 'm-me', url: 'https://hooks.example.com/g', project_id: null, is_active: false });
    expect(container.textContent).not.toContain(tm.misconfigGlobalActive);
  });
});
