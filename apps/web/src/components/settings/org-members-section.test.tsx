// @vitest-environment jsdom
//
// story #2485 — 초대 실패 PLAN_LIMIT_EXCEEDED(EE plan_limits.check_member_invite_limit()가
// 실제로 낸다, 그라운딩 확認)는 분기하고, 나머지는 backend가 generic HTTP상태만 준다 —
// raw 서버 message 노출 대신 고정 문구인지 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OrgMembersSection } from './org-members-section';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function wrapEn(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountAndInvite(inviteResponse: { ok: boolean; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/org-members') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/organizations/org-1/invites' && (!init || init.method === undefined)) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/organizations/org-1/invites' && init?.method === 'POST') {
      return { ok: inviteResponse.ok, json: async () => inviteResponse.body };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
  await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="admin" />)); });
  await flush();

  const emailInput = Array.from(container.querySelectorAll('input')).find((i) => i.placeholder === 'email@example.com') as HTMLInputElement;
  await act(async () => { setNativeValue(emailInput, 'new@example.com'); });
  const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '초대');
  await act(async () => { inviteBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

// story #3231(카디르 버그사냥) — Member 신분에게 email 포함 전체 로스터가 새던 결함.
// BE가 admin/owner 전용 403으로 잠근 것이 실 정본이고, 여기서는 그 서버 거부를 FE가
// 안내 문구로 정확히 반영하는지·Member 신분엔 로스터 fetch 자체를 안 쏘는지 검증한다.
describe('OrgMembersSection — Member 신분엔 관리자 전용 안내(story #3231)', () => {
  it('currentRole=member — 안내 문구만 보이고 email/멤버 데이터는 아예 안 뜬다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="member" />)); });
    await flush();

    expect(container.textContent).toContain(koMessages.settings.orgMembersAdminOnly);
    expect(container.textContent).toContain(koMessages.settings.orgMembersAdminOnlyHint);
    // 하드닝(feedback_guard_must_declare_what_it_misses류) — 안내 문구가 떴다는 것만으론
    // 부족, 애초에 로스터/초대/프로젝트 fetch 자체를 안 쐈는지까지 직접 확인한다.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('currentRole=admin — 무회귀, 기존처럼 멤버 섹션 정상 렌더', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/org-members') return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/organizations/org-1/invites') return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="admin" />)); });
    await flush();

    expect(container.textContent).not.toContain(koMessages.settings.orgMembersAdminOnly);
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/org-members')).toBe(true);
  });
});

describe('OrgMembersSection — error.code 분기 (story #2485)', () => {
  it('PLAN_LIMIT_EXCEEDED — raw 영문 대신 번역 문구', async () => {
    await mountAndInvite({
      ok: false,
      body: { error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'member', limit: 3, message: 'Free plan member limit (3) reached.' } },
    });
    expect(container.textContent).not.toContain('Free plan member limit');
    expect(container.textContent).toContain(koMessages.settings.memberLimitExceededError.replace('{limit}', '3'));
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    await mountAndInvite({
      ok: false,
      body: { error: { code: 'CONFLICT', message: 'Email already a member of this organization' } },
    });
    expect(container.textContent).not.toContain('Email already a member');
    expect(container.textContent).toContain(koMessages.settings.memberInviteFailed);
  });
});

// story #3491(페드루 PO 確定) — FE 게이트가 BE 인가(owner·admin)와 정확히 같은 폭인지.
// admin caller가 member는 편집하되 owner 행·자기 자신 행은 못 건드리는 것을 실 렌더로 잰다.
async function mountAsAdmin(members: Array<{ id: string; user_id: string; role: 'owner' | 'admin' | 'member'; name?: string }>, currentUserId: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/org-members') {
      return {
        ok: true,
        json: async () => ({
          data: members.map((m) => ({ id: m.id, user_id: m.user_id, name: m.name ?? 'M', role: m.role, created_at: '2026-09-01T00:00:00Z' })),
        }),
      };
    }
    if (url === '/api/organizations/org-1/invites') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: currentUserId } }) };
    throw new Error('unexpected fetch: ' + url);
  }));
  await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="admin" />)); });
  await flush();
}

// story #3608(유나 §22-18 ④-2, PO 確定 2026-09-07) — 초대 대기 행의 재발송·취소
// pending 中 "..."가 위 aria-label 안에도 그대로 들어갔다(발견 시점 실측, #3592가
// 이 두 자리에 순번 aria-label을 이미 배선해 뒀지만 낱말화는 놓쳤다).
describe('OrgMembersSection — 초대 pending 라벨 낱말화(story #3608)', () => {
  async function mountWithPendingInvite() {
    let resolveResend!: () => void;
    let resolveRevoke!: () => void;
    const resendPending = new Promise<void>((resolve) => { resolveResend = resolve; });
    const revokePending = new Promise<void>((resolve) => { resolveRevoke = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/org-members') return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/organizations/org-1/invites' && (!init || init.method === undefined)) {
        return { ok: true, json: async () => ({ data: [{ id: 'inv-1', email: 'x@example.com', role: 'member', status: 'pending', expires_at: '2026-09-10T00:00:00Z' }] }) };
      }
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/organizations/org-1/invites/inv-1/resend' && init?.method === 'POST') {
        await resendPending;
        return { ok: true, json: async () => ({}) };
      }
      if (url === '/api/organizations/org-1/invites/inv-1' && init?.method === 'DELETE') {
        await revokePending;
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="admin" />)); });
    await flush();
    return { resolveResend, resolveRevoke };
  }

  it('⭐#3608 — 재발송 pending 中 접근 이름·보이는 글자에 "..." 0, "재발송 중" 포함', async () => {
    const { resolveResend } = await mountWithPendingInvite();
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '재발송');
    expect(resendBtn).not.toBeUndefined();
    await act(async () => { resendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(resendBtn!.textContent).not.toContain('...');
    expect(resendBtn!.textContent).toContain('재발송 중');
    const ariaLabel = resendBtn!.getAttribute('aria-label');
    expect(ariaLabel).not.toContain('...');
    expect(ariaLabel).toContain('재발송 중');
    resolveResend();
    await flush();
  });

  it('⭐#3608 — 취소 pending 中 접근 이름·보이는 글자에 "..." 0, "취소 중" 포함', async () => {
    const { resolveRevoke } = await mountWithPendingInvite();
    const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '취소');
    expect(cancelBtn).not.toBeUndefined();
    await act(async () => { cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(cancelBtn!.textContent).not.toContain('...');
    expect(cancelBtn!.textContent).toContain('취소 중');
    const ariaLabel = cancelBtn!.getAttribute('aria-label');
    expect(ariaLabel).not.toContain('...');
    expect(ariaLabel).toContain('취소 중');
    resolveRevoke();
    await flush();
  });
});

describe('OrgMembersSection — 역할 변경 게이트가 BE 인가 폭과 같다(story #3491)', () => {
  it('⭐admin caller — owner도 자기 자신도 아닌 member 행엔 <select>가 뜬다(FE=BE 폭 정정의 핵심)', async () => {
    await mountAsAdmin(
      [
        { id: 'row-owner', user_id: 'u-owner', role: 'owner' },
        { id: 'row-self', user_id: 'u-admin-self', role: 'admin' },
        { id: 'row-other', user_id: 'u-member', role: 'member' },
      ],
      'u-admin-self',
    );

    const selects = container.querySelectorAll('select');
    expect(selects.length).toBe(1); // owner 행·자기 자신 행은 select가 없다.
  });

  it('⭐<select>엔 owner 옵션이 없다(BE가 admin의 owner 부여를 거부하니 UI도 안 보인다)', async () => {
    await mountAsAdmin(
      [{ id: 'row-other', user_id: 'u-member', role: 'member' }],
      'u-admin-self',
    );

    const select = container.querySelector('select')!;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['admin', 'member']);
    expect(optionValues).not.toContain('owner');
  });

  it('member fixture는 관리자 전용 안내로 막혀 select 자체가 없다(회귀 0, story #3231과 조합)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="member" />)); });
    await flush();
    expect(container.querySelectorAll('select').length).toBe(0);
  });
});

// story #3771(PO 별건 ㉓·유나 r65 라이브 픽셀) — 역할 변경 불가 행(소유자·자기 자신)의
// 배지가 제거 버튼 자리로 밀려 세로 정렬이 「소유자/제거/제거」로 섞였다. 액션 열은
// canEdit 무관하게 항상 같은 개수(2: 역할 슬롯+액션 슬롯)를 렌더해야 한다 — 액션
// 슬롯은 canEdit=false일 때도 같은 텍스트의 Button을 invisible로 그려 폭을 지킨다.
describe('OrgMembersSection — 역할 열/액션 열 자리 고정(story #3771)', () => {
  it('⭐owner 행·자기 자신 행도 "제거" 버튼 엘리먼트가 DOM에 있다(자리만 invisible) — member 행은 보이는 버튼', async () => {
    await mountAsAdmin(
      [
        { id: 'row-owner', user_id: 'u-owner', role: 'owner' },
        { id: 'row-self', user_id: 'u-admin-self', role: 'admin' },
        { id: 'row-other', user_id: 'u-member', role: 'member' },
      ],
      'u-admin-self',
    );

    const removeButtons = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent === koMessages.settings.removeFromProject);
    // 세 행 전부(owner·self·member) "제거" 버튼 엘리먼트 자체는 존재해야 한다(자리 고정).
    expect(removeButtons.length).toBe(3);

    const [ownerBtn, selfBtn, otherBtn] = removeButtons;
    expect(ownerBtn.className).toContain('invisible');
    expect(ownerBtn.getAttribute('aria-hidden')).toBe('true');
    expect(ownerBtn.tabIndex).toBe(-1);

    expect(selfBtn.className).toContain('invisible');
    expect(selfBtn.getAttribute('aria-hidden')).toBe('true');

    // member 행(변경 가능)의 버튼은 실제로 보이고 클릭 가능해야 한다 — 회귀 0.
    expect(otherBtn.className).not.toContain('invisible');
    expect(otherBtn.getAttribute('aria-hidden')).not.toBe('true');
    expect(otherBtn.tabIndex).not.toBe(-1);
  });
});

// story #3606(잔여, 페드루 PO 確定 2026-09-07) — 이 파일 전체가 t() 없는 하드코딩
// 한글이라 en 로케일에서도 한국어가 그대로 노출됐다(초대 폼 제목·설명·성공/실패
// 배너·멤버/초대 목록 헤딩·행 액션 버튼 등). 실 렌더(멤버 1행+대기 초대 1행 —
// 두 SectionCard 다 그려야 전수를 잰다)로 en 로케일에서 한글이 0임을 고정한다.
const HANGUL_RE = /[가-힣]/;

async function mountEnWithData() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/org-members') {
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'm1', user_id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'member', created_at: '2026-09-01T00:00:00Z' }],
        }),
      };
    }
    if (url === '/api/organizations/org-1/invites') {
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'inv1', email: 'bob@example.com', role: 'member', status: 'pending', expires_at: '2026-09-14T00:00:00Z', invite_url: 'https://sprintable.example/i/abc' }],
        }),
      };
    }
    if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
    if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: 'u-admin-self' } }) };
    throw new Error('unexpected fetch: ' + url);
  }));
  await act(async () => { root.render(wrapEn(<OrgMembersSection orgId="org-1" currentRole="admin" />)); });
  await flush();
}

describe('OrgMembersSection — en 로케일 한글 노출 0(story #3606, i18n 갭 마감)', () => {
  it('멤버 1행+대기 초대 1행 실 렌더 — 화면 텍스트 전체에 한글이 하나도 없다', async () => {
    await mountEnWithData();
    expect(container.textContent).not.toMatch(HANGUL_RE);
    // 실제로 영문 대체 텍스트가 서 있는지도 같이(빈 렌더링으로 "우연히 0건" 방지).
    expect(container.textContent).toContain(enMessages.settings.orgMembersHeading);
    expect(container.textContent).toContain(enMessages.settings.invite);
    expect(container.textContent).toContain(enMessages.settings.removeFromProject);
    expect(container.textContent).toContain(enMessages.share.copyLink);
    expect(container.textContent).toContain(enMessages.settings.resend);
    expect(container.textContent).toContain(enMessages.common.cancel);
  });

  // 뮤테이션 대조 — 이 검산이 실제로 한글 잔재를 잡는지 자가 증명(하드코딩 한글이
  // 남아있는 걸 흉내 낸 조각을 검사기에 직접 먹여 RED가 남을 확인).
  it('뮤테이션 대조 — 한글이 섞인 텍스트는 이 정규식이 반드시 잡는다', () => {
    expect('Members (1) 가입').toMatch(HANGUL_RE);
  });
});

// story #3735(UI 점검 B·E절, 유나 定) — 수를 제목 문자열 안에 넣지 않는다. 목록 헤더가
// "구성원 ({count})" 한 문자열이 아니라 제목 고정("구성원") + 별도 CountBadge로 갈라졌는지
// 회귀로 고정한다(이벤트 화면 events/page.tsx와 동형).
describe('OrgMembersSection — 목록 헤더 제목 고정 + CountBadge(story #3735)', () => {
  it('헤더가 「구성원 (N)」 한 문자열이 아니라 제목("구성원")과 수(CountBadge)가 갈라져 있다', async () => {
    await mountAsAdmin([
      { id: 'm1', user_id: 'u1', role: 'owner', name: 'A' },
      { id: 'm2', user_id: 'u2', role: 'member', name: 'B' },
      { id: 'm3', user_id: 'u3', role: 'member', name: 'C' },
    ], 'u1');

    // "조직 전체 구성원"(orgMembersHeading, 상단 초대 카드 제목)도 "구성원"을 포함해
    // 구별해야 한다 — 목록 헤더는 CountBadge(span)를 갖는 쪽 하나뿐이다.
    const headings = Array.from(container.querySelectorAll('h2')).filter((h) => h.textContent?.includes('구성원'));
    expect(headings.length).toBeGreaterThan(1);
    const heading = headings.find((h) => h.querySelector('span'));
    expect(heading).toBeDefined();
    // 제목 자체엔 괄호 수식이 없다 — "구성원 (3)"처럼 한 문자열로 붙어 있으면 실패.
    expect(heading!.textContent).not.toMatch(/구성원\s*\(/);
    // 수는 헤더 안 별도 요소(CountBadge)로 존재한다.
    const badge = heading!.querySelector('span');
    expect(badge?.textContent).toContain('3');
  });

  // story #3735 CHANGES(유나 재검토) — 옆 "초대 대기" 섹션 헤더가 옛 괄호 형("초대 대기
  // ({count})")으로 남아 같은 화면 안 두 형이 세로로 나란히 서는 불일치가 있었다. 초대
  // 대기 1건 이상이면 이 섹션이 함께 선다(유나 실측) — 같은 처방으로 통일됐는지 고정.
  it('「초대 대기」 헤더도 같은 처방(제목 고정 + CountBadge)이다 — 두 헤더 형이 갈리지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/org-members') {
        return { ok: true, json: async () => ({ data: [{ id: 'm1', user_id: 'u1', name: 'A', role: 'owner', created_at: '2026-09-01T00:00:00Z' }] }) };
      }
      if (url === '/api/organizations/org-1/invites') {
        return { ok: true, json: async () => ({ data: [{ id: 'inv-1', email: 'x@example.com', role: 'member', status: 'pending', expires_at: '2026-09-10T00:00:00Z' }] }) };
      }
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: 'u1' } }) };
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<OrgMembersSection orgId="org-1" currentRole="admin" />)); });
    await flush();

    const heading = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent?.includes('초대 대기'));
    expect(heading).toBeDefined();
    expect(heading!.textContent).not.toMatch(/초대 대기\s*\(/);
    expect(heading!.querySelector('span')?.textContent).toContain('1');
  });
});
