// @vitest-environment jsdom
//
// story #3749(재설계 ⑤, 시안 ④⑤ v3b 74290976) — 역할별 SectionCard 쪼개기를 걷고
// 역할 칩으로 좁히는 한 목록으로 갈아엎는다. story #3737(D1)이 pin하던 「그룹 제목은
// role_label 고정 문자열, 수는 별도 배지」 규율은 SectionCard 자체가 없어지며 그
// 구조(h2 그룹 헤더)가 사라졌다 — 그 규율의 정신("한 문자열 안에 수를 지어내 붙이지
// 않는다")은 이제 역할 칩 라벨이 이어받는다(trustRoleFilter="{role} {n}명" 키 자체가
// 이미 그 계약이라 새 pin이 그 키 값을 그대로 검증한다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import OrganizationTrustPage from './page';

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

const ORG_ID = 'org-1';

function mountAsAdmin() {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: 'Org', orgSlug: 'org', role: 'admin' }],
    projectMemberships: [], projectId: 'proj-1', currentTeamMemberId: 'member-1',
  });
}

function mountAsSelf() {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: 'Org', orgSlug: 'org', role: 'member' }],
    projectMemberships: [], projectId: 'proj-1', currentTeamMemberId: 'member-1',
  });
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

interface StubMember {
  member_id: string; role_key: string; role_label: string | null;
  hit_rate: number | null; resolved: number | null; computed_at: string; pending: number | null;
}

function stubFetchAdmin(members: StubMember[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/trust-scores/org-summary') {
      return { ok: true, status: 200, json: async () => ({ members }) };
    }
    if (url === '/api/org-members') {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (url.startsWith('/api/team-members')) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

interface StubScore {
  role_key: string; role_label: string | null; hit_rate: number | null; resolved: number | null; pending: number | null;
}

function stubFetchSelf(scores: StubScore[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/trust-scores?member_id=')) {
      return { ok: true, status: 200, json: async () => ({ scores }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

describe('OrganizationTrustPage — 역할 칩(story #3749, 3737 D1 정신 계승)', () => {
  it('⭐칩 라벨은 「{역할} {n}명」이고 수는 그 역할 실제 행 수와 정확히 일치한다(뮤테이션 표적 — 다른 역할 수를 섞으면 실패해야 한다)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'implementation', role_label: '구현', hit_rate: 0.9, resolved: 5, computed_at: '2026-09-09T00:00:00Z', pending: 0 },
      { member_id: 'm2', role_key: 'implementation', role_label: '구현', hit_rate: 0.8, resolved: 4, computed_at: '2026-09-09T00:00:00Z', pending: 0 },
      { member_id: 'm3', role_key: 'qa', role_label: 'QA', hit_rate: 0.7, resolved: 3, computed_at: '2026-09-09T00:00:00Z', pending: 0 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const chips = [...container.querySelectorAll('[data-testid="trust-role-filter-role"]')];
    expect(chips).toHaveLength(2);
    const implChip = chips.find((c) => c.textContent?.startsWith('구현'));
    const qaChip = chips.find((c) => c.textContent?.startsWith('QA'));
    expect(implChip?.textContent).toBe(koMessages.organization.trustRoleFilter.replace('{role}', '구현').replace('{n}', '2'));
    expect(qaChip?.textContent).toBe(koMessages.organization.trustRoleFilter.replace('{role}', 'QA').replace('{n}', '1'));
  });

  it('⭐「모든 역할」 칩엔 수가 없다(행 수=사람×역할 쌍 수라 사람 수로 읽히면 거짓)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: 0.9, resolved: 5, computed_at: '2026-09-09T00:00:00Z', pending: 0 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const allChip = container.querySelector('[data-testid="trust-role-filter-all"]');
    expect(allChip?.textContent).toBe(koMessages.organization.trustAllRolesFilter);
    expect(allChip?.textContent).not.toMatch(/\d/);
  });

  it('⭐역할 칩을 클릭하면 그 역할 행만 남는다(다른 역할 행은 목록에서 빠진다)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: 0.9, resolved: 5, computed_at: '2026-09-09T00:00:00Z', pending: 0 },
      { member_id: 'm2', role_key: 'qa', role_label: 'QA', hit_rate: 0.7, resolved: 3, computed_at: '2026-09-09T00:00:00Z', pending: 0 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();
    expect(container.querySelectorAll('[data-testid="trust-roster-row"]')).toHaveLength(2);

    const qaChip = [...container.querySelectorAll('[data-testid="trust-role-filter-role"]')].find((c) => c.textContent?.startsWith('QA')) as HTMLElement;
    await act(async () => { qaChip.click(); });
    await flush();

    const rows = container.querySelectorAll('[data-testid="trust-roster-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('QA');
  });
});

describe('OrganizationTrustPage — 콜드스타트 두 갈래(story #3749, 定 — 계약에 없는 수 0)', () => {
  // 뮤테이션 표적 — resolved===0∧pending>0일 때 수 없는 문장이 뜨면(또는 반대) 이
  // 단언들이 실패해야 한다(두 갈래가 실제로 갈리는지 검증).
  it('⭐resolved=0·pending>0 — 「판정 대기 가설 {n}건이 판정되면 섭니다」(수 있음)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: null, resolved: 0, computed_at: '2026-09-09T00:00:00Z', pending: 3 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const row = container.querySelector('[data-testid="trust-roster-row"]');
    expect(row?.textContent).toContain(koMessages.organization.trustColdStartPendingReason.replace('{n}', '3'));
    expect(row?.textContent).not.toContain(koMessages.organization.trustColdStartEmptyReason);
    // 값 자리는 여전히 trustColdStart chip("데이터 부족") — 정②의 시간 부제로 안 샌다.
    expect(row?.textContent).toContain(koMessages.organization.trustColdStart);
  });

  it('⭐resolved=0·pending=0 — 「아직 판정한 가설이 없습니다」(수 없음, "3건" 류 계약에 없는 수 0)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: null, resolved: 0, computed_at: '2026-09-09T00:00:00Z', pending: 0 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const row = container.querySelector('[data-testid="trust-roster-row"]');
    expect(row?.textContent).toContain(koMessages.organization.trustColdStartEmptyReason);
    expect(row?.textContent).not.toContain(koMessages.organization.trustColdStartPendingReason.replace('{n}', ''));
  });

  it('resolved=0인데 pending이 null(계약 부재)이면 수 없는 문장으로 떨어진다(모른다≠지어낸 수)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: null, resolved: 0, computed_at: '2026-09-09T00:00:00Z', pending: null },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const row = container.querySelector('[data-testid="trust-roster-row"]');
    expect(row?.textContent).toContain(koMessages.organization.trustColdStartEmptyReason);
  });
});

describe('OrganizationTrustPage — 정상 행 부제·값(story #3749 定②)', () => {
  it('⭐정상 행 부제는 「{role} · {time} 기준」 형(formatScheduledAt, 상대 시각 아님)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: 0.5, resolved: 4, computed_at: '2026-09-08T00:00:00Z', pending: 0 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const row = container.querySelector('[data-testid="trust-roster-row"]');
    // formatScheduledAt "MM-DD HH:mm {TZ}" 형 — 상대 시각("전"/"그저께") 아님.
    expect(row?.textContent).toMatch(/개발 · \d{2}-\d{2} \d{2}:\d{2} /);
    expect(row?.textContent).not.toMatch(/전|그저께|어제|오늘/);
  });

  it('⭐「적중 {rate}%」 값이 뜬다(정상 행은 trustColdStart chip 대신 이 값)', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: 0.82, resolved: 11, computed_at: '2026-09-08T00:00:00Z', pending: 0 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const rateText = container.querySelector('[data-testid="trust-hit-rate-text"]');
    expect(rateText?.textContent).toBe(koMessages.organization.trustHitRate.replace('{rate}', '82'));
    expect(container.querySelector('[data-testid="trust-roster-row"]')?.textContent).not.toContain(koMessages.organization.trustColdStart);
  });
});

describe('OrganizationTrustPage — 「추이 보기」 펼침(HistoryDrilldown 무변경 회귀가드)', () => {
  it('⭐「추이 보기」 버튼이 상시 노출되고(outline 버튼) 클릭 시 이력을 펼친다', async () => {
    mountAsAdmin();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/trust-scores/org-summary') {
        return {
          ok: true, status: 200,
          json: async () => ({ members: [{ member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: 0.9, resolved: 5, computed_at: '2026-09-08T00:00:00Z', pending: 0 }] }),
        };
      }
      if (url === '/api/org-members' || url.startsWith('/api/team-members')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (url.startsWith('/api/trust-scores/history')) {
        return { ok: true, status: 200, json: async () => ({ snapshots: [{ computed_at: '2026-09-08T00:00:00Z', hit_rate: 0.9, resolved: 5 }] }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const toggle = container.querySelector('[data-testid="trust-history-toggle"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.tagName).toBe('BUTTON');
    await act(async () => { toggle.click(); });
    await flush();

    expect(container.textContent).toContain(koMessages.organization.trustHistoryToggle);
  });
});

describe('OrganizationTrustPage — 하단 참고 문장(定③)', () => {
  it('⭐목록이 있으면 하단에 정③ 문장이 뜬다', async () => {
    mountAsAdmin();
    stubFetchAdmin([
      { member_id: 'm1', role_key: 'dev', role_label: '개발', hit_rate: 0.9, resolved: 5, computed_at: '2026-09-08T00:00:00Z', pending: 0 },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="trust-hit-rate-meaning"]')?.textContent).toBe(koMessages.organization.trustHitRateMeaning);
  });

  it('로스터가 비면 하단 문장도 안 뜬다(설명할 목록 자체가 없음)', async () => {
    mountAsAdmin();
    stubFetchAdmin([]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="trust-hit-rate-meaning"]')).toBeNull();
  });
});

describe('OrganizationTrustPage — 「내 신뢰」 self 뷰(story #3749 §6, 같은 행 부품)', () => {
  it('⭐self 뷰는 역할 칩이 없다(칩은 admin 전용)', async () => {
    mountAsSelf();
    stubFetchSelf([{ role_key: 'dev', role_label: '개발', hit_rate: 0.9, resolved: 5, pending: 0 }]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    expect(container.querySelector('[data-testid="trust-role-filter"]')).toBeNull();
    expect(container.querySelector('[data-testid="trust-self-row"]')).not.toBeNull();
  });

  it('⭐self 콜드스타트 행 부제는 역할 접두 없이 사유 문장만(title이 이미 역할명이라 중복 방지)', async () => {
    mountAsSelf();
    stubFetchSelf([{ role_key: 'dev', role_label: '개발', hit_rate: null, resolved: 0, pending: 2 }]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const row = container.querySelector('[data-testid="trust-self-row"]');
    const expectedReason = koMessages.organization.trustColdStartPendingReason.replace('{n}', '2');
    expect(row?.textContent).toContain(expectedReason);
    // "개발 · 판정 대기…"처럼 역할이 두 번 서면 안 된다(title에 이미 있음).
    expect(row?.textContent?.match(/개발/g)?.length).toBe(1);
  });

  it('빈 self 뷰는 trustEmptySelf 문구를 보인다', async () => {
    mountAsSelf();
    stubFetchSelf([]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    expect(container.textContent).toContain(koMessages.organization.trustEmptySelf);
  });
});

describe('OrganizationTrustPage — PageHeader(⓪, story #3749)', () => {
  it('⭐제목 trustSlotTitle·설명 정①(trustPurposeFraming) 값이 그대로 뜬다', async () => {
    mountAsAdmin();
    stubFetchAdmin([]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    expect(container.querySelector('h1')?.textContent).toBe(koMessages.organization.trustSlotTitle);
    expect(container.textContent).toContain(koMessages.organization.trustPurposeFraming);
    // 定① 옛 값("오케스트레이션")은 걷었다.
    expect(container.textContent).not.toContain('오케스트레이션');
  });
});
