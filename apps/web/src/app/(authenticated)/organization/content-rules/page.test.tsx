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
  banned_terms: ['무료체험'], require_utm: true, tone: '친근하게' as string | null, taxonomy: ['공지'],
  channel_priority: ['threads', 'wordpress'],
  brand_kit: { logo_url: 'https://x.example/logo.png' as string | undefined, colors: ['#111'], fonts: ['Pretendard'] },
  generation_budget: null as { limit_minor: number; currency: 'KRW' | 'USD'; period: 'month' } | null,
};

function stubFetch(opts: {
  rules?: typeof RULES_V1;
  version?: number;
  onPut?: (body: unknown) => { status: number; body?: unknown };
  budget?: { limit_minor: number | null; spent_minor: number; remaining_minor: number | null; currency: 'KRW' | 'USD' | null; period: 'month' };
  // story #3501(doc a0da40c9 §20-4) — 409 재검증 경로가 실제로 별도 GET을 쳐 "새
  // 서버값"을 얻는지 확認하려면, 그 GET이 «다른» 값을 돌려줘야 한다. 첫 PUT이
  // 409를 낸 뒤부터 GET이 이 값을 돌려준다(그 전엔 rules/version 그대로).
  getAfterConflict?: { rules: typeof RULES_V1; version: number };
}) {
  const rules = opts.rules ?? RULES_V1;
  const version = opts.version ?? 3;
  const budget = opts.budget ?? { limit_minor: null, spent_minor: 0, remaining_minor: null, currency: null, period: 'month' as const };
  let conflictTriggered = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/generation-budget')) {
      return new Response(JSON.stringify({ data: budget }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/content-rules') && (!init || init.method === undefined || init.method === 'GET')) {
      const current = conflictTriggered && opts.getAfterConflict ? opts.getAfterConflict : { rules, version };
      return new Response(JSON.stringify({ data: { org_id: ORG_ID, rules: current.rules, version: current.version } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/content-rules') && init?.method === 'PUT') {
      const body = init.body ? JSON.parse(init.body as string) : null;
      const result = opts.onPut?.(body) ?? { status: 200, body: { org_id: ORG_ID, rules: body?.rules ?? rules, version: version + 1 } };
      if (result.status === 409) conflictTriggered = true;
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

  // 카디르군 REQUEST_CHANGES(2026-09-05, PR#3827) — require_utm 토글·tone·brand_kit
  // logo_url 세 필드가 disabled={!isOwner}만 붙은 "살아 있는" input/checkbox였다
  // (나머지 4필드=TagListEditor는 진작 읽기 전용 텍스트로 바뀌어 있었다 — 여섯 필드
  // 전수 대신 readOnly 분기 하나만 보고 넘어간 최초 대조 갭). 여섯 필드 전수로 pin.
  it('⭐member — 여섯 필드 전수: 살아있는 input/checkbox 0개, 값은 텍스트로 전부 보인다', async () => {
    stubFetch({});
    await mount('member');
    // 편집 가능한 폼 컨트롤이 화면 전체에 하나도 없다(살아있는 컨트롤=탭 순서에
    // 남아 스크린리더가 여전히 편집 가능한 것으로 읽는다).
    expect(container.querySelectorAll('input, textarea')).toHaveLength(0);

    expect(container.querySelector('[data-testid="content-rules-require-utm"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-rules-require-utm-readonly"]')?.textContent)
      .toBe(koMessages.contentRules.requireUtmOnLabel);
    expect(container.querySelector('[data-testid="content-rules-tone-readonly"]')?.textContent).toBe('친근하게');
    expect(container.querySelector('[data-testid="content-rules-brand-logo-readonly"]')?.textContent)
      .toBe('https://x.example/logo.png');
  });

  it('member — tone·로고가 비어 있으면 「—」로 보인다(값 없음 표시)', async () => {
    stubFetch({ rules: { ...RULES_V1, tone: null, brand_kit: { ...RULES_V1.brand_kit, logo_url: undefined } } });
    await mount('member');
    expect(container.querySelector('[data-testid="content-rules-tone-readonly"]')?.textContent).toBe('—');
    expect(container.querySelector('[data-testid="content-rules-brand-logo-readonly"]')?.textContent).toBe('—');
  });

  it('⭐admin도 편집 컨트롤을 본다(story #3490 — owner만이던 자격을 owner·admin으로)', async () => {
    stubFetch({});
    await mount('admin');
    expect(container.querySelector('[data-testid="content-rules-save-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-rules-banned-terms-editor"]')).not.toBeNull();
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

  it('403 CONTENT_RULES_ADMIN_ONLY — 인라인 문구', async () => {
    stubFetch({ onPut: () => ({ status: 403, body: { code: 'CONTENT_RULES_ADMIN_ONLY' } }) });
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

  it('⭐저장 요청 body에 expected_version이 로드된 버전 그대로 실린다', async () => {
    let sentBody: unknown = null;
    stubFetch({
      onPut: (body) => { sentBody = body; return { status: 200, body: { org_id: ORG_ID, rules: RULES_V1, version: 4 } }; },
    });
    await mount('owner');
    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();
    expect((sentBody as { expected_version?: number } | null)?.expected_version).toBe(3);
  });
});

describe('ContentRulesPage — 낙관적 잠금 충돌(story #3501, doc a0da40c9 §20)', () => {
  const SERVER_CHANGED = {
    ...RULES_V1, banned_terms: ['서버측_새금칙'], // "먼저 저장된 변경" = banned_terms
  };

  it('⭐409(이름 있음) — "{이름}이 먼저 저장했습니다"+두 목록+저장 비활성+사유', async () => {
    stubFetch({
      onPut: () => ({
        status: 409,
        body: { code: 'CONTENT_RULES_VERSION_CONFLICT', current_version: 4, updated_by: { member_id: 'm-1', name: '유나' } },
      }),
      getAfterConflict: { rules: SERVER_CHANGED, version: 4 },
    });
    await mount('owner');

    // 내 로컬 편집 — tone을 바꾼다("되돌아갈 내 편집" = tone).
    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '내가 고친 톤');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    const banner = container.querySelector('[data-testid="content-rules-version-conflict"]');
    expect(banner?.textContent).toContain(koMessages.contentRules.versionConflictFactWithName.replace('{name}', '유나'));
    expect(banner?.textContent).not.toContain(koMessages.contentRules.versionConflictFact);
    expect(banner?.textContent).toContain(
      koMessages.contentRules.versionConflictPriorChanged.replace('{list}', koMessages.contentRules.bannedTermsLabel),
    );
    expect(banner?.textContent).toContain(
      koMessages.contentRules.versionConflictMyChanges.replace('{list}', koMessages.contentRules.toneLabel),
    );

    expect(saveBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="content-rules-save-disabled-reason"]')?.textContent)
      .toBe(koMessages.contentRules.versionConflictSaveDisabledReason);
  });

  it('409(이름 없음) — 화면이 모르는 것은 지어내지 않고 일반 사실 문구만', async () => {
    stubFetch({
      onPut: () => ({
        status: 409,
        body: { code: 'CONTENT_RULES_VERSION_CONFLICT', current_version: 4, updated_by: null },
      }),
      getAfterConflict: { rules: SERVER_CHANGED, version: 4 },
    });
    await mount('owner');
    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();
    const banner = container.querySelector('[data-testid="content-rules-version-conflict"]');
    expect(banner?.textContent).toContain(koMessages.contentRules.versionConflictFact);
  });

  it('⭐"다시 불러오기" — 자동 병합도 조용한 폐기도 아니다: 서버값으로 갈아끼우고 되돌린 필드 이름을 한 줄 남긴다', async () => {
    stubFetch({
      onPut: () => ({
        status: 409,
        body: { code: 'CONTENT_RULES_VERSION_CONFLICT', current_version: 4, updated_by: null },
      }),
      getAfterConflict: { rules: SERVER_CHANGED, version: 4 },
    });
    await mount('owner');

    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '내가 고친 톤');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    const reloadBtn = container.querySelector('[data-testid="content-rules-reload-button"]') as HTMLButtonElement;
    await act(async () => { reloadBtn.click(); });
    await flush();

    // 서버값(SERVER_CHANGED)으로 실제로 갈아끼워졌다 — 내가 고친 톤이 아니라 원래 톤.
    expect((container.querySelector('#content-rules-tone') as HTMLInputElement).value).toBe(RULES_V1.tone);
    expect(container.textContent).toContain('서버측_새금칙');
    expect(container.querySelector('[data-testid="content-rules-version"]')?.textContent)
      .toBe(koMessages.contentRules.versionLabel.replace('{version}', '4'));

    // 되돌린 필드 이름 한 줄이 남는다 — 값이 아니라 이름만.
    expect(container.querySelector('[data-testid="content-rules-rolled-back-note"]')?.textContent).toBe(
      koMessages.contentRules.versionConflictRolledBack.replace('{list}', koMessages.contentRules.toneLabel),
    );

    // 충돌이 풀려 저장 버튼이 다시 활성화된다.
    expect((container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[data-testid="content-rules-version-conflict"]')).toBeNull();
  });

  it('겹치는 필드(진짜 충돌)가 각 목록의 맨 앞에 온다', async () => {
    // 서버가 tone을 바꿨고(먼저 저장된 변경), 나도 tone을 바꿨다(되돌아갈 내 편집) — 겹침.
    stubFetch({
      onPut: () => ({
        status: 409,
        body: { code: 'CONTENT_RULES_VERSION_CONFLICT', current_version: 4, updated_by: null },
      }),
      getAfterConflict: { rules: { ...RULES_V1, tone: '서버가 바꾼 톤', banned_terms: ['서버측_새금칙'] }, version: 4 },
    });
    await mount('owner');

    // 내 로컬 편집 — tone(겹침)과 require_utm(안 겹침) 둘 다 바꾼다.
    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '내가 고친 톤');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const utmCheckbox = container.querySelector('[data-testid="content-rules-require-utm"]') as HTMLInputElement;
    await act(async () => { utmCheckbox.click(); });

    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    const banner = container.querySelector('[data-testid="content-rules-version-conflict"]');
    // §20-4 "겹치는 이름은 앞에 둔다" — tone(겹침)이 require_utm(안 겹침)보다 리스트
    // 앞에 와야 정확한 문구가 된다(순서가 틀리면 이 exact-match가 깨진다).
    const expectedMyChanges = [koMessages.contentRules.toneLabel, koMessages.contentRules.requireUtmLabel].join(', ');
    expect(banner?.textContent).toContain(
      koMessages.contentRules.versionConflictMyChanges.replace('{list}', expectedMyChanges),
    );
  });
});

describe('ContentRulesPage — 생성 비용 한도(story #3500, BE #3498 미착지 — fixture)', () => {
  it('owner — 정책 미설정(null)이면 "정책 없음" 입력이 비어 있고 select도 없다', async () => {
    stubFetch({});
    await mount('owner');
    const limitInput = container.querySelector('[data-testid="content-rules-generation-budget-limit"]') as HTMLInputElement;
    expect(limitInput.value).toBe('');
    expect(container.querySelector('[data-testid="content-rules-generation-budget-currency"]')).toBeNull();
  });

  it('member — 정책 미설정(null)이면 읽기 전용으로 "정책 없음"을 본다', async () => {
    stubFetch({});
    await mount('member');
    expect(container.querySelector('[data-testid="content-rules-generation-budget-readonly"]')?.textContent)
      .toBe(koMessages.contentRules.generationBudgetNotSet);
    expect(container.querySelector('[data-testid="content-rules-generation-budget-limit"]')).toBeNull();
  });

  it('member — limit_minor=0이면 읽기 전용으로 "정지"를 본다(정책 미설정과 다른 값)', async () => {
    stubFetch({ rules: { ...RULES_V1, generation_budget: { limit_minor: 0, currency: 'KRW', period: 'month' } } });
    await mount('member');
    expect(container.querySelector('[data-testid="content-rules-generation-budget-readonly"]')?.textContent)
      .toBe(koMessages.contentRules.generationBudgetSuspendedReadonly);
  });

  it('member — 양수 한도면 값+통화를 읽기 전용으로 본다(§19-1 콤마 포맷)', async () => {
    stubFetch({ rules: { ...RULES_V1, generation_budget: { limit_minor: 100000, currency: 'KRW', period: 'month' } } });
    await mount('member');
    const text = container.querySelector('[data-testid="content-rules-generation-budget-readonly"]')?.textContent ?? '';
    expect(text).toBe('100,000원');
  });

  it('member — USD 한도는 exponent 2로 변환돼 "$"+소수 2자리로 보인다(§19-1 회귀 방지 — KRW와 다른 자릿수)', async () => {
    // limit_minor=30000(분단위, 센트) → USD exponent=2 → $300.00. 만약 exponent 변환을
    // 빼먹고 KRW처럼 그대로 찍으면 "30,000$"류로 잘못 보여 이 단언이 깨진다.
    stubFetch({ rules: { ...RULES_V1, generation_budget: { limit_minor: 30000, currency: 'USD', period: 'month' } } });
    await mount('member');
    const text = container.querySelector('[data-testid="content-rules-generation-budget-readonly"]')?.textContent ?? '';
    expect(text).toBe('$300.00');
  });

  it('⭐owner가 한도를 입력하고 저장하면 새 버전에 그대로 반영된다(round-trip)', async () => {
    stubFetch({});
    await mount('owner');

    const limitInput = container.querySelector('[data-testid="content-rules-generation-budget-limit"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(limitInput, '50000');
      limitInput.dispatchEvent(new Event('input', { bubbles: true }));
      limitInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    // currency select가 이제 나타난다(정책이 생겼으므로).
    expect(container.querySelector('[data-testid="content-rules-generation-budget-currency"]')).not.toBeNull();

    const saveBtn = container.querySelector('[data-testid="content-rules-save-button"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });
    await flush();

    expect(container.querySelector('[data-testid="content-rules-version"]')?.textContent).toBe(koMessages.contentRules.versionLabel.replace('{version}', '4'));
    const limitInputAfter = container.querySelector('[data-testid="content-rules-generation-budget-limit"]') as HTMLInputElement;
    expect(limitInputAfter.value).toBe('50000');
  });

  it('owner — 한도 입력을 비우면 정책 전체가 null로 되돌아간다(0=정지와 다름)', async () => {
    stubFetch({ rules: { ...RULES_V1, generation_budget: { limit_minor: 30000, currency: 'USD', period: 'month' } } });
    await mount('owner');
    const limitInput = container.querySelector('[data-testid="content-rules-generation-budget-limit"]') as HTMLInputElement;
    // §19-1 — 입력은 큰단위(major)다. 30000분단위(센트)/exponent 2 = $300(큰단위).
    expect(limitInput.value).toBe('300');

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(limitInput, '');
      limitInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-testid="content-rules-generation-budget-currency"]')).toBeNull();
  });

  it('잔량 3상태(GenerationBudgetIndicator)가 규칙 섹션 옆에도 뜬다', async () => {
    stubFetch({ budget: { limit_minor: 100000, spent_minor: 20000, remaining_minor: 80000, currency: 'KRW', period: 'month' } });
    await mount('owner');
    expect(container.querySelector('[data-testid="generation-budget-remaining-full"]')).not.toBeNull();
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
