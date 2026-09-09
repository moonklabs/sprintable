// @vitest-environment jsdom
//
// story #3747(UI 재설계 ⑥, 유나 시안 e07f98c6 v3 — 구획 넷) — 「긴 폼 하나+저장 하나」를
// 「규칙 목록 + 규칙마다 고치기」로. #3472/#3501/#3532/#3540/#3490의 기존 계약(권한·
// 낙관적 잠금·색 스와치·UTM 자동 부착)은 그대로, 화면 구조만 행 목록으로 바뀐다.
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
  brand_kit: { logo_url: 'https://x.example/logo.png', colors: ['#111'], fonts: ['Pretendard'] } as { logo_url?: string; colors?: string[]; fonts?: string[] },
  generation_budget: null as { limit_minor: number; currency: 'KRW' | 'USD'; period: 'month' } | null,
  utm_rules: null as { enabled: boolean; default_source: string | null; default_medium: string | null; campaign_from: string; content_from: string } | null,
};

function stubFetch(opts: {
  rules?: typeof RULES_V1;
  version?: number;
  updatedAt?: string | null;
  updatedByName?: string | null;
  onPut?: (body: unknown) => { status: number; body?: unknown };
  budget?: { limit_minor: number | null; spent_minor: number; remaining_minor: number | null; currency: 'KRW' | 'USD' | null; period: 'month' };
  // story #3501(§20-4) 재사용 — 409 뒤 재조회가 실제로 "새 서버값"을 얻는지 확認하려면
  // 그 GET이 다른 값을 돌려줘야 한다. 첫 PUT이 409를 낸 뒤부터 GET이 이 값을 돌려준다.
  getAfterConflict?: { rules: typeof RULES_V1; version: number };
}) {
  const rules = opts.rules ?? RULES_V1;
  const version = opts.version ?? 3;
  const updatedAt = opts.updatedAt === undefined ? '2026-09-07T00:00:00Z' : opts.updatedAt;
  const updatedBy = opts.updatedByName === undefined ? { member_id: 'm-owner', name: '송윤재' } : (opts.updatedByName === null ? null : { member_id: 'm-owner', name: opts.updatedByName });
  const budget = opts.budget ?? { limit_minor: null, spent_minor: 0, remaining_minor: null, currency: null, period: 'month' as const };
  let conflictTriggered = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/generation-budget')) {
      return new Response(JSON.stringify({ data: budget }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/content-rules') && (!init || init.method === undefined || init.method === 'GET')) {
      const current = conflictTriggered && opts.getAfterConflict
        ? { ...opts.getAfterConflict, updated_at: updatedAt, updated_by: updatedBy }
        : { rules, version, updated_at: updatedAt, updated_by: updatedBy };
      return new Response(JSON.stringify({ data: { org_id: ORG_ID, ...current } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/content-rules') && init?.method === 'PUT') {
      const body = init.body ? JSON.parse(init.body as string) : null;
      const result = opts.onPut?.(body) ?? {
        status: 200,
        body: { org_id: ORG_ID, rules: body?.rules ?? rules, version: version + 1, updated_at: updatedAt, updated_by: updatedBy },
      };
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

function row(field: string) {
  return container.querySelector(`[data-testid="content-rules-row-${field}"]`)!;
}

async function expandRow(field: string) {
  const btn = container.querySelector(`[data-testid="content-rules-row-action-${field}"]`) as HTMLButtonElement;
  await act(async () => { btn.click(); });
  await flush();
}

function rowSaveButton() {
  return container.querySelector('[data-testid="content-rules-row-save"]') as HTMLButtonElement;
}

describe('ContentRulesPage — 조회·표시(story #3747)', () => {
  it('행마다 값이 보이고, 저장한 이력이 있으면 헤더 부제가 「마지막 변경 {날짜}·{이름}」이다', async () => {
    stubFetch({});
    await mount('owner');
    expect(row('banned_terms').textContent).toContain('무료체험');
    expect(row('tone').textContent).toContain('친근하게');
    const header = container.querySelector('[data-testid="content-rules-last-changed"]')!;
    // story #3747 CHANGES(§11-2 정본 formatScheduledAt) — "MM-DD HH:mm TZ" 꼴(브라우저
    // toLocaleString 아님). TZ는 테스트 실행 환경에 따라 달라 정규식으로만 pin.
    expect(header.textContent).toMatch(/마지막 변경 09-07 \d{2}:\d{2} .+ · 송윤재/);
  });

  it('⭐아직 한 번도 규칙을 안 정한 조직(row 자체가 없음) — 「아직 정한 적 없습니다」(빈 줄 아님)', async () => {
    stubFetch({ updatedAt: null, updatedByName: null, rules: { ...RULES_V1, banned_terms: [], tone: null } });
    await mount('owner');
    const header = container.querySelector('[data-testid="content-rules-last-changed"]')!;
    expect(header.textContent).toContain(koMessages.contentRules.pageNeverSetSuffix);
    expect(header.textContent).not.toContain('마지막 변경');
  });

  it('updated_by_member_id가 null이면(이름 모름) 날짜만 — 지어내지 않는다', async () => {
    stubFetch({ updatedByName: null });
    await mount('owner');
    const header = container.querySelector('[data-testid="content-rules-last-changed"]')!;
    expect(header.textContent).toMatch(/마지막 변경 09-07 \d{2}:\d{2} /);
  });

  it('⭐member는 행 액션(고치기/정하기) 버튼이 없고 값은 그대로 본다(secret 아님)', async () => {
    stubFetch({});
    await mount('member');
    expect(row('banned_terms').textContent).toContain('무료체험');
    expect(container.querySelector('[data-testid="content-rules-row-action-banned_terms"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.contentRules.readOnlyReason);
  });

  it('값이 없는 필드는 「안 정함」으로 보인다(톤·택소노미·채널우선순위·브랜드킷·utm_rules 전부)', async () => {
    stubFetch({ rules: { ...RULES_V1, tone: null, taxonomy: [], channel_priority: [], brand_kit: {}, utm_rules: null } });
    await mount('member');
    expect(row('tone').textContent).toContain(koMessages.contentRules.contentRulesNotSetLabel);
    expect(row('taxonomy').textContent).toContain(koMessages.contentRules.contentRulesNotSetLabel);
    expect(row('channel_priority').textContent).toContain(koMessages.contentRules.contentRulesNotSetLabel);
    expect(row('brand_kit').textContent).toContain(koMessages.contentRules.contentRulesNotSetLabel);
    expect(row('utm_rules').textContent).toContain(koMessages.contentRules.contentRulesNotSetLabel);
  });

  it('행 액션 라벨 — 값 있으면 「고치기」, 없으면 「정하기」(require_utm은 불리언이라 항상 「고치기」)', async () => {
    stubFetch({ rules: { ...RULES_V1, tone: null, channel_priority: [] } });
    await mount('owner');
    expect(container.querySelector('[data-testid="content-rules-row-action-banned_terms"]')?.textContent).toBe(koMessages.contentRules.contentRulesEditAction);
    expect(container.querySelector('[data-testid="content-rules-row-action-tone"]')?.textContent).toBe(koMessages.contentRules.contentRulesSetAction);
    expect(container.querySelector('[data-testid="content-rules-row-action-channel_priority"]')?.textContent).toBe(koMessages.contentRules.contentRulesSetAction);
    expect(container.querySelector('[data-testid="content-rules-row-action-require_utm"]')?.textContent).toBe(koMessages.contentRules.contentRulesEditAction);
    expect(container.querySelector('[data-testid="content-rules-row-action-utm_rules"]')?.textContent).toBe(koMessages.contentRules.contentRulesSetAction);
  });
});

describe('ContentRulesPage — UTM 검사 3통(story #3747ⓒ, require_utm×utm_rules.enabled)', () => {
  it('require_utm=false — 「꺼짐」', async () => {
    stubFetch({ rules: { ...RULES_V1, require_utm: false, utm_rules: null } });
    await mount('owner');
    expect(container.querySelector('[data-testid="content-rules-require-utm-status"]')?.textContent).toContain(koMessages.contentRules.requireUtmOffLabel);
  });

  it('require_utm=true·utm_rules.enabled=false — 「켜짐」만(자동충족 문구 없음)', async () => {
    stubFetch({ rules: { ...RULES_V1, require_utm: true, utm_rules: { enabled: false, default_source: null, default_medium: null, campaign_from: 'campaign_slug', content_from: 'draft_id' } } });
    await mount('owner');
    const status = container.querySelector('[data-testid="content-rules-require-utm-status"]')?.textContent ?? '';
    expect(status).toContain(koMessages.contentRules.requireUtmOnLabel);
    expect(status).not.toContain('자동 부착이 켜져 있어');
  });

  it('⭐require_utm=true·utm_rules.enabled=true — 자동 충족 문구("지금은 걸리지 않습니다")', async () => {
    stubFetch({ rules: { ...RULES_V1, require_utm: true, utm_rules: { enabled: true, default_source: null, default_medium: null, campaign_from: 'campaign_slug', content_from: 'draft_id' } } });
    await mount('owner');
    expect(container.querySelector('[data-testid="content-rules-require-utm-status"]')?.textContent)
      .toContain(koMessages.contentRules.requireUtmOnAutoFulfilledStatus);
  });
});

describe('ContentRulesPage — UTM 자동 부착 3통(story #3747ⓒ, utm_rules null≠꺼짐)', () => {
  it('⭐utm_rules===null — 「안 정함」(꺼짐 아님)', async () => {
    stubFetch({ rules: { ...RULES_V1, utm_rules: null } });
    await mount('owner');
    const status = container.querySelector('[data-testid="content-rules-utm-rules-status"]')?.textContent ?? '';
    expect(status).toContain(koMessages.contentRules.contentRulesNotSetLabel);
    expect(status).not.toContain(koMessages.contentRules.utmRulesEnabledOffLabel);
  });

  it('utm_rules.enabled===false — 「꺼짐」', async () => {
    stubFetch({ rules: { ...RULES_V1, utm_rules: { enabled: false, default_source: null, default_medium: null, campaign_from: 'campaign_slug', content_from: 'draft_id' } } });
    await mount('owner');
    expect(container.querySelector('[data-testid="content-rules-utm-rules-status"]')?.textContent).toContain(koMessages.contentRules.utmRulesEnabledOffLabel);
  });

  it('utm_rules.enabled===true — 「켜짐」+source·medium·content 값', async () => {
    stubFetch({ rules: { ...RULES_V1, utm_rules: { enabled: true, default_source: 'sprintable', default_medium: 'social', campaign_from: 'campaign_slug', content_from: 'draft_id' } } });
    await mount('owner');
    const status = container.querySelector('[data-testid="content-rules-utm-rules-status"]')?.textContent ?? '';
    expect(status).toContain(koMessages.contentRules.utmRulesEnabledOnLabel);
    expect(status).toContain('sprintable');
    expect(status).toContain('social');
  });
});

describe('ContentRulesPage — 한 번에 한 행만 펼침(page 소유 expandedField)', () => {
  it('한 행을 펼친 상태에서 다른 행을 펼치면 앞 행은 접힌다', async () => {
    stubFetch({});
    await mount('owner');
    await expandRow('banned_terms');
    expect(container.querySelector('[data-testid="content-rules-banned-terms-editor"]')).not.toBeNull();

    await expandRow('tone');
    expect(container.querySelector('[data-testid="content-rules-banned-terms-editor"]')).toBeNull();
    expect(container.querySelector('#content-rules-tone')).not.toBeNull();
  });

  it('같은 행 액션을 다시 누르면 접힌다', async () => {
    stubFetch({});
    await mount('owner');
    await expandRow('tone');
    expect(container.querySelector('#content-rules-tone')).not.toBeNull();
    await expandRow('tone');
    expect(container.querySelector('#content-rules-tone')).toBeNull();
  });
});

describe('ContentRulesPage — 행 저장(story #3747 AC2)', () => {
  it('⭐톤을 고쳐 저장하면 그 행이 새 값으로 반영되고 접히며 성공 토스트+되돌리기가 뜬다', async () => {
    stubFetch({});
    await mount('owner');
    await expandRow('tone');

    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '더 친근하게');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rowSaveButton().click(); });
    await flush();

    expect(container.querySelector('#content-rules-tone')).toBeNull(); // 접힘
    expect(row('tone').textContent).toContain('더 친근하게');
    expect(container.textContent).toContain(koMessages.contentRules.contentRulesRowSaveSuccessToast);
    expect(container.textContent).toContain(koMessages.contentRules.contentRulesUndoAction);
  });

  it('⭐금칙어를 추가해 저장하면 PUT body에 rules 전체(다른 필드 포함)+expected_version이 실린다', async () => {
    let sentBody: unknown = null;
    stubFetch({ onPut: (body) => { sentBody = body; return { status: 200, body: { org_id: ORG_ID, rules: { ...RULES_V1, banned_terms: ['무료체험', '광고성문구'] }, version: 4, updated_at: '2026-09-07T00:00:00Z', updated_by: { member_id: 'm', name: '송윤재' } } }; } });
    await mount('owner');
    await expandRow('banned_terms');

    const input = container.querySelector('[data-testid="content-rules-banned-terms-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '광고성문구');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    await act(async () => { rowSaveButton().click(); });
    await flush();

    const body = sentBody as { rules?: typeof RULES_V1; expected_version?: number } | null;
    expect(body?.expected_version).toBe(3);
    expect(body?.rules?.banned_terms).toEqual(['무료체험', '광고성문구']);
    expect(body?.rules?.tone).toBe('친근하게'); // 다른 필드는 그대로 실린다(통짜 PUT).
  });

  it('⭐되돌리기 — 직전 값으로 다시 저장한다', async () => {
    let putCount = 0;
    stubFetch({
      onPut: (body) => {
        putCount += 1;
        const b = body as { rules: typeof RULES_V1 };
        return { status: 200, body: { org_id: ORG_ID, rules: b.rules, version: 3 + putCount, updated_at: '2026-09-07T00:00:00Z', updated_by: { member_id: 'm', name: '송윤재' } } };
      },
    });
    await mount('owner');
    await expandRow('tone');
    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '바뀐 톤');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rowSaveButton().click(); });
    await flush();
    expect(row('tone').textContent).toContain('바뀐 톤');

    const undoBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.contentRules.contentRulesUndoAction) as HTMLButtonElement;
    await act(async () => { undoBtn.click(); });
    await flush();

    expect(row('tone').textContent).toContain('친근하게');
    expect(putCount).toBe(2);
  });

  it('403 CONTENT_RULES_ADMIN_ONLY — 그 행 안에 인라인 오류', async () => {
    stubFetch({ onPut: () => ({ status: 403, body: { code: 'CONTENT_RULES_ADMIN_ONLY' } }) });
    await mount('owner');
    await expandRow('tone');
    await act(async () => { rowSaveButton().click(); });
    await flush();
    expect(row('tone').textContent).toContain(koMessages.contentRules.errorOwnerOnly);
  });

  it('422 CONTENT_RULES_INVALID — 그 행 안에 인라인 오류', async () => {
    stubFetch({ onPut: () => ({ status: 422, body: { code: 'CONTENT_RULES_INVALID' } }) });
    await mount('owner');
    await expandRow('tone');
    await act(async () => { rowSaveButton().click(); });
    await flush();
    expect(row('tone').textContent).toContain(koMessages.contentRules.errorInvalidField);
  });
});

describe('ContentRulesPage — 겹침 기반 낙관적 잠금(story #3747ⓐ, 페드루 정정 — PUT+겹침, PATCH 아님)', () => {
  it('⭐겹치는 필드(서버도 내가 고친 그 필드를 바꿨음) — 충돌 배너, 재시도 안 함', async () => {
    stubFetch({
      onPut: () => ({ status: 409, body: { code: 'CONTENT_RULES_VERSION_CONFLICT', current_version: 4, updated_by: { member_id: 'm-1', name: '유나' } } }),
      getAfterConflict: { rules: { ...RULES_V1, tone: '서버가 먼저 바꾼 톤' }, version: 4 },
    });
    await mount('owner');
    await expandRow('tone');
    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '내가 고친 톤');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rowSaveButton().click(); });
    await flush();

    const banner = container.querySelector('[data-testid="content-rules-version-conflict"]');
    expect(banner?.textContent).toContain(
      koMessages.contentRules.versionConflictFieldWithName.replace('{name}', '유나').replace('{field}', koMessages.contentRules.toneLabel),
    );
    // 재시도 안 함 — 서버측 값(tone)으로 화면이 갈아끼워진다.
    expect(row('tone').textContent).toContain('서버가 먼저 바꾼 톤');
  });

  it('⭐안 겹치는 필드(서버는 다른 필드를 바꿨음) — 조용히 최신 버전으로 재저장, 자동 rebase 토스트', async () => {
    let putCalls = 0;
    stubFetch({
      onPut: (body) => {
        putCalls += 1;
        if (putCalls === 1) return { status: 409, body: { code: 'CONTENT_RULES_VERSION_CONFLICT', current_version: 4, updated_by: null } };
        const b = body as { rules: typeof RULES_V1 };
        return { status: 200, body: { org_id: ORG_ID, rules: b.rules, version: 5, updated_at: '2026-09-07T00:00:00Z', updated_by: { member_id: 'm', name: '송윤재' } } };
      },
      // 서버가 실제로 바꾼 건 banned_terms(내가 고치는 필드=tone과 안 겹침).
      getAfterConflict: { rules: { ...RULES_V1, banned_terms: ['서버측_새금칙'] }, version: 4 },
    });
    await mount('owner');
    await expandRow('tone');
    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '내가 고친 톤');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rowSaveButton().click(); });
    await flush();

    expect(container.querySelector('[data-testid="content-rules-version-conflict"]')).toBeNull();
    expect(putCalls).toBe(2); // 최초 409 + 자동 재저장 1회.
    expect(row('tone').textContent).toContain('내가 고친 톤'); // 내 변경은 관철됐다.
    expect(row('banned_terms').textContent).toContain('서버측_새금칙'); // 서버측 변경도 보존됐다.
    expect(container.textContent).toContain(koMessages.contentRules.contentRulesAutoRebasedToast);
  });

  // ⭐되돌리면 무한재귀 — 자동 재저장 자체도 또 안 겹치는 409를 맞으면(드문 동시쓰기
  // 폭주) 한 번만 재시도하고 멈춘다. loadedRules 기준선이 이 함수 호출 동안 안 바뀌어
  // 두 번째부터는 겹침 판정 자체가 못 믿을 값이 되기도 한다(정확성+무한루프 방지 둘 다).
  it('⭐재시도도 또 안 겹치는 409면 한 번만 재시도하고 멈춘다(무한 재귀 금지)', async () => {
    let putCalls = 0;
    stubFetch({
      onPut: () => {
        putCalls += 1;
        return { status: 409, body: { code: 'CONTENT_RULES_VERSION_CONFLICT', current_version: 4 + putCalls, updated_by: null } };
      },
      getAfterConflict: { rules: { ...RULES_V1, banned_terms: ['서버측_새금칙'] }, version: 4 },
    });
    await mount('owner');
    await expandRow('tone');
    const toneInput = container.querySelector('#content-rules-tone') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(toneInput, '내가 고친 톤');
      toneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rowSaveButton().click(); });
    await flush();

    expect(putCalls).toBe(2); // 최초 시도 + 재시도 1회뿐 — 그 이상 안 돈다.
    expect(row('tone').textContent).toContain(koMessages.contentRules.saveFailed);
  });
});

describe('ContentRulesPage — 생성 비용 한도(story #3500 계약, 행으로 재배치)', () => {
  it('정책 미설정(null)이면 「안 정함」', async () => {
    stubFetch({});
    await mount('member');
    expect(row('generation_budget').textContent).toContain(koMessages.contentRules.contentRulesNotSetLabel);
  });

  it('limit_minor=0이면 「정지」(정책 미설정과 다른 값)', async () => {
    stubFetch({ rules: { ...RULES_V1, generation_budget: { limit_minor: 0, currency: 'KRW', period: 'month' } } });
    await mount('member');
    expect(row('generation_budget').textContent).toContain(koMessages.contentRules.generationBudgetSuspendedReadonly);
  });

  it('⭐양수 한도 — 금액+"지금까지 {씀}" 지출액이 같은 줄에 뜬다', async () => {
    stubFetch({
      rules: { ...RULES_V1, generation_budget: { limit_minor: 100000, currency: 'KRW', period: 'month' } },
      budget: { limit_minor: 100000, spent_minor: 12400, remaining_minor: 87600, currency: 'KRW', period: 'month' },
    });
    await mount('member');
    const text = row('generation_budget').textContent ?? '';
    expect(text).toContain('100,000원');
    expect(text).toContain(koMessages.contentRules.generationBudgetSpentSoFarSuffix.replace('{spent}', '12,400원'));
  });

  it('owner가 한도를 입력하고 저장하면 그 행에 반영된다', async () => {
    stubFetch({ onPut: (body) => ({ status: 200, body: { org_id: ORG_ID, rules: (body as { rules: typeof RULES_V1 }).rules, version: 4, updated_at: '2026-09-07T00:00:00Z', updated_by: { member_id: 'm', name: '송윤재' } } }) });
    await mount('owner');
    await expandRow('generation_budget');
    const limitInput = container.querySelector('[data-testid="content-rules-generation-budget-limit"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(limitInput, '50000');
      limitInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { rowSaveButton().click(); });
    await flush();
    expect(row('generation_budget').textContent).toContain('50,000원');
  });
});

describe('ContentRulesPage — 브랜드 킷(story #3532 계승)', () => {
  it('로고 URL·색 칩이 행 값 줄에 뜬다(폰트는 요약 줄엔 안 나옴, 폼 안에만)', async () => {
    stubFetch({});
    await mount('member');
    const text = row('brand_kit').textContent ?? '';
    expect(text).toContain('https://x.example/logo.png');
    expect(text).toContain('#111');
  });

  it('⭐유효한 CSS 색이면 칩에 스와치가 붙는다(요약 줄)', async () => {
    stubFetch({ rules: { ...RULES_V1, brand_kit: { ...RULES_V1.brand_kit, colors: ['#3366ff'] } } });
    await mount('member');
    expect(row('brand_kit').querySelector('[style*="background-color"]')).not.toBeNull();
  });

  it('로고·색 둘 다 없으면 「안 정함」', async () => {
    stubFetch({ rules: { ...RULES_V1, brand_kit: {} } });
    await mount('member');
    const text = row('brand_kit').textContent ?? '';
    expect(text).toContain(koMessages.contentRules.contentRulesNotSetLabel);
  });

  it('⭐폼을 펼치면 로고 미리보기·색·폰트 세 필드가 다 있다', async () => {
    stubFetch({});
    await mount('owner');
    await expandRow('brand_kit');
    expect(container.querySelector('[data-testid="content-rules-brand-logo-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-rules-brand-colors-editor"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-rules-brand-fonts-editor"]')).not.toBeNull();
  });
});

describe('ContentRulesPage — 채널 우선순위(story #3472 계승)', () => {
  it('요약 줄에 순위+채널이 칩으로 뜬다', async () => {
    stubFetch({});
    await mount('member');
    const text = row('channel_priority').textContent ?? '';
    expect(text).toContain('1');
    expect(text).toContain('threads');
    expect(text).toContain('2');
    expect(text).toContain('wordpress');
  });

  it('owner가 폼에서 ↑/↓로 순서를 바꿀 수 있다', async () => {
    stubFetch({});
    await mount('owner');
    await expandRow('channel_priority');
    const list = container.querySelector('[data-testid="content-rules-channel-priority-list"]')!;
    expect(list.textContent).toMatch(/1\. threads[\s\S]*2\. wordpress/);
    const downBtn = Array.from(list.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'threads 아래로 이동') as HTMLButtonElement;
    await act(async () => { downBtn.click(); });
    await flush();
    expect(list.textContent).toMatch(/1\. wordpress[\s\S]*2\. threads/);
  });
});

// story #3436 묶음11 — TagChip 제거 버튼 접근성 이름이 한국어(하드코딩 영문 회귀 방지).
describe('ContentRulesPage — 태그 제거 버튼 접근성 이름(story #3436 묶음11)', () => {
  it('제거 버튼 aria-label이 한국어 「{item} 제거」다', async () => {
    stubFetch({});
    await mount('owner');
    await expandRow('banned_terms');
    const editor = container.querySelector('[data-testid="content-rules-banned-terms-editor"]')!;
    const removeBtn = editor.querySelector('button[aria-label]') as HTMLButtonElement;
    expect(removeBtn.getAttribute('aria-label')).toBe('무료체험 제거');
    expect(removeBtn.getAttribute('aria-label')).not.toContain('Remove');
  });
});

describe('ContentRulesPage — 하단 문구(story #3747)', () => {
  it('푸터에 「이름·날짜」 중복 없이 정본 문구만 있다', async () => {
    stubFetch({});
    await mount('owner');
    expect(container.textContent).toContain(koMessages.contentRules.contentRulesFooterNote);
  });
});
