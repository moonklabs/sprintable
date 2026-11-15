// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면, 유나 ds 부품) — 스프린트 만들기 폼의 시작일 · 종료일 칸. 예전엔 <label>이 칸과 이어지지 않아(htmlFor 없음) 날짜 칸에 접근 이름이 없었다.
// 이제 ds Field가 이름을 칸에 잇고 ds Input이 모양을 쥔다. 값 · 초안 · 전송 모양은 그대로 — 그걸 함께 못박는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
const wrap = (n: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { id: 'sp-1' } }), text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function mount() {
  const { CreateDialog } = await import('./sprints-client');
  await act(async () => { root.render(wrap(<CreateDialog projectId="proj-1" onCreated={() => {}} onClose={() => {}} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const dates = () => [...document.body.querySelectorAll('input[type=date]')] as HTMLInputElement[];
function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) as HTMLButtonElement | undefined;

describe('스프린트 만들기 폼 — 시작일 · 종료일(story #4888)', () => {
  it('⭐두 날짜 칸이 ds Input이고 접근 이름이 있다(«시작일» · «종료일») — 예전엔 이름이 없었다 · 폰 높이 44 클래스', async () => {
    await mount();
    expect(dates()).toHaveLength(2);
    for (const input of dates()) {
      expect(input.getAttribute('data-slot')).toBe('ds-input');
      expect(input.className.split(/\s+/)).toContain('touch:h-11');
      expect(input.required).toBe(true);
    }
    expect(dates()[0]!.labels?.[0]?.textContent).toBe(koMessages.sprints.startDate);
    expect(dates()[1]!.labels?.[0]?.textContent).toBe(koMessages.sprints.endDate);
    // 이름이 서로 다른 칸에 이어졌다(같은 id 하나에 둘이 걸리지 않는다)
    expect(dates()[0]!.id).not.toBe(dates()[1]!.id);
  });

  it('⭐미리 채워진 날짜(오늘 · 오늘+13일)와 고른 날짜가 «만들기» 전송에 그대로 실린다(start_date · end_date)', async () => {
    await mount();
    const [start, end] = dates() as [HTMLInputElement, HTMLInputElement];
    expect(start.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end.value > start.value).toBe(true);
    await act(async () => { setValue(start, '2026-12-01'); setValue(end, '2026-12-14'); });
    expect(start.value).toBe('2026-12-01');
    expect(end.value).toBe('2026-12-14');
    await act(async () => { setValue(document.body.querySelector<HTMLInputElement>(`input[placeholder="${koMessages.sprints.sprintTitlePlaceholder}"]`)!, '12월 스프린트'); });
    await act(async () => { button(koMessages.sprints.saveDraft)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/sprints') && (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(post, 'POST /api/sprints').toBeTruthy();
    const body = JSON.parse((post![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ title: '12월 스프린트', start_date: '2026-12-01', end_date: '2026-12-14' });
  });

  it('날짜를 지우면(빈 값) «필수 입력» 안내가 뜨고 전송은 안 나간다 — 예전 동작 그대로', async () => {
    await mount();
    await act(async () => { setValue(dates()[0]!, ''); });
    await act(async () => { setValue(document.body.querySelector<HTMLInputElement>(`input[placeholder="${koMessages.sprints.sprintTitlePlaceholder}"]`)!, '이름'); });
    await act(async () => { button(koMessages.sprints.saveDraft)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain(koMessages.sprints.missingRequired);
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });
});
