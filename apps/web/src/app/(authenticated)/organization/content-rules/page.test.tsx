// @vitest-environment jsdom
//
// story #3472(BE #3825, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 화면. BE #3825가
// 아직 병합 전이라 stub fetch로 계약(GET/PUT .../content-rules → {org_id, rules,
// version})만 먼저 짠다(3450 BFF→화면 선례와 동형 — 라이브 왕복은 BE 착지 뒤).
// organization/channels/page.test.tsx와 동형 harness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import ContentRulesPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const ORG_ID = 'org-1';

let container: HTMLDivElement;
let root: Root;

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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const RULES_V1 = {
  banned_terms: ['무료체험'], require_utm: true, tone: '친근하게', taxonomy: ['공지'],
  channel_priority: ['threads', 'wordpress'], brand_kit: { logo_url: 'https://x.example/logo.png', colors: ['#111'], fonts: ['Pretendard'] },
};

function stubFetch(opts: {
  rules?: typeof RULES_V1;
  version?: number;
  onPut?: (body: unknown) => { status: number; body?: unknown };
}) {
  const rules = opts.rules ?? RULES_V1;
  const version = opts.version ?? 3;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/content-rules') && (!init || init.method === undefined || init.method === 'GET')) {
      return new Response(JSON.stringify({ data: { org_id: ORG_ID, rules, version } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/content-rules') && init?.method === 'PUT') {
      const body = init.body ? JSON.parse(init.body as string) : null;
      const result = opts.onPut?.(body) ?? { status: 200, body: { org_id: ORG_ID, rules: body?.rules ?? rules, version: version + 1 } };
      const ok = result.status < 400;
      return new Response(JSON.stringify(ok ? { data: result.body } : { data: null, error: result.body }), {
        status: result.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: null, error: { code: 'NOT_FOUND' } }), { status: 404 });
  }));
}

async function mount(role: string) {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID, orgMemberships: [{ orgId: ORG_ID, orgName: 'Org', orgSlug: 'org', role }], projectMemberships: [],
  });
  await act(async () => { root.render(wrap(<ContentRulesPage />)); });
  await flush();
}

describe('ContentRulesPage — 조회·표시(story #3472)', () => {
  it('버전과 저장된 값이 보인다(owner)', async () => {
    stubFetch({});
    await mount('owner');
    expect(container.querySelector('[data-testid="content-rules-version"]')?.textContent).toBe(koMessages.contentRules.versionLabel.replace('{version}', '3'));
    expect(container.textContent).toContain('무료체험');
    expect((container.querySelector('#content-rules-tone') as HTMLInputElement)?.value).toBe('친근하게');
    expect((container.querySelector('[data-testid="content-rules-require-utm"]') as HTMLInputElement)?.checked).toBe(true);
  });

  it('⭐member는 편집 컨트롤이 없고 owner 전용 사유만 본다(읽기는 됨)', async () => {
    stubFetch({});
    await mount('member');
    expect(container.textContent).toContain('무료체험'); // 값은 보인다(secret 아님)
    expect(container.querySelector('[data-testid="content-rules-save-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-rules-banned-terms-editor"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-rules-banned-terms-readonly"]')).not.toBeNull();
    expect(container.textContent).toContain(koMessages.contentRules.readOnlyReason);
  });

  it('⭐admin도 편집 컨트롤이 없다(owner-or-admin 상수 재사용 금지 — 정확히 owner만)', async () => {
    stubFetch({});
    await mount('admin');
    expect(container.querySelector('[data-testid="content-rules-save-button"]')).toBeNull();
  });
});

describe('ContentRulesPage — 저장(story #3472 AC1)', () => {
  it('⭐owner가 금칙어를 추가하고 저장하면 새 버전이 반영된다', async () => {
    stubFetch({});
    await mount('owner');

    const input = container.querySelector('[data-testid="content-rules-banned-terms-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '광고성문구');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.textContent).toContain('광고성문구');

    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    expect(container.querySelector('[data-testid="content-rules-version"]')?.textContent).toBe(koMessages.contentRules.versionLabel.replace('{version}', '4'));
    expect(container.textContent).toContain(koMessages.contentRules.saveSuccess.replace('{version}', '4'));
  });

  it('403 CONTENT_RULES_OWNER_ONLY — 인라인 문구', async () => {
    stubFetch({ onPut: () => ({ status: 403, body: { code: 'CONTENT_RULES_OWNER_ONLY' } }) });
    await mount('owner');
    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(koMessages.contentRules.errorOwnerOnly);
  });

  it('⭐422 CONTENT_RULES_INVALID(field 실려 옴) — 그 필드 옆에 표시', async () => {
    stubFetch({ onPut: () => ({ status: 422, body: { code: 'CONTENT_RULES_INVALID', field: 'tone' } }) });
    await mount('owner');
    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();
    const toneInput = container.querySelector('#content-rules-tone')!;
    const fieldError = toneInput.parentElement?.querySelector('.text-destructive');
    expect(fieldError?.textContent).toBe(koMessages.contentRules.errorInvalidField);
    // field 있는 422는 폼 상단 배너로는 안 뜬다(중복 표시 방지).
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('422 CONTENT_RULES_INVALID(field 없음) — 폼 상단 배너로 폴백', async () => {
    stubFetch({ onPut: () => ({ status: 422, body: { code: 'CONTENT_RULES_INVALID' } }) });
    await mount('owner');
    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(koMessages.contentRules.errorInvalid);
  });
});

describe('ContentRulesPage — 채널 우선순위 정렬(story #3472)', () => {
  it('owner는 ↑/↓로 순서를 바꿀 수 있다', async () => {
    stubFetch({});
    await mount('owner');
    const list = container.querySelector('[data-testid="content-rules-channel-priority-list"]')!;
    expect(list.textContent).toMatch(/1\. threads[\s\S]*2\. wordpress/);

    const downBtn = Array.from(list.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Move threads down') as HTMLButtonElement;
    await act(async () => { downBtn.click(); });
    await flush();
    expect(list.textContent).toMatch(/1\. wordpress[\s\S]*2\. threads/);
  });

  it('member는 순서 변경 버튼이 없다', async () => {
    stubFetch({});
    await mount('member');
    const list = container.querySelector('[data-testid="content-rules-channel-priority-list"]')!;
    expect(list.querySelectorAll('button')).toHaveLength(0);
  });
});
