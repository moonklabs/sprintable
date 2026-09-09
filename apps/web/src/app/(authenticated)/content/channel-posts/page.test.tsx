// @vitest-environment jsdom
//
// story #3402(Phase1·마케팅운영, AC1/AC2/AC3) — 채널 포스트 목록 화면. content/page.test.tsx
// (site-posts)와 동형 harness(useDashboardContext 목·NextIntlClientProvider·createRoot·
// stubFetch) — 다섯 상태 파생 세부 분기는 channel-post-status.test.ts가 이미 잡으므로, 이
// 파일은 "목록 계약 필드가 화면에 정확히 배선됐는지"(N+1 없이 목록 응답만으로 렌더)와
// "채널 고유 신호(partialSuccess/publicationFailed)가 실제로 보이는지"만 pin한다.
//
// story #3744(UI 재설계 ①, 미르코 2026-09-09) — content/page.test.tsx(site-posts)와 동형
// 재설계. ⋯ DropdownMenu 배선에 맞춰 openRowMenu 헬퍼 추가. 채널 연결 조회(GET .../
// channel-connections)가 새로 추가된 선행 fetch라 모든 스텁이 그 응답도 같이 낸다 —
// 기본은 활성 연결 1개(대부분 테스트가 그 갈래 밖에서 목록 자체를 검증하므로).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';
import { ToastProvider, ToastContainer, useToast } from '@/components/ui/toast';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

// story #3744 — ⋯ 행 메뉴의 「승인 요청 보기」가 useRouter().push()로 이동한다
// (content/page.test.tsx와 동형 mock 관례).
const { routerPushMock } = vi.hoisted(() => ({ routerPushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

import ChannelPostListPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// story #3759 — 이 컴포넌트가 useToast()로 공유 Context를 구독한다. 정적 import된
// 컴포넌트라(파일 상단) vi.resetModules()의 영향을 안 받는 이 파일 자체의 정적
// ToastProvider로 감싸면 된다(동적 재-import 처방 불요, content/page.test.tsx와 동형).
function TestToastRenderer() {
  const { toasts, dismissToast } = useToast();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToastProvider>
        {node}
        <TestToastRenderer />
      </ToastProvider>
    </NextIntlClientProvider>
  );
}

const ORG_ID = 'org-1';
const ONE_ACTIVE_CONNECTION = [{ id: 'conn-1', status: 'active' }];

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ orgId: ORG_ID, orgMemberships: [], projectMemberships: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// story #3744 — 행 액션이 이제 ⋯ DropdownMenu 안에 있다(base-ui가 content를
// document.body에 portal — container 스코프 밖). content/page.test.tsx와 동형.
async function openRowMenu(n = 0) {
  const triggers = container.querySelectorAll('[data-testid="channel-post-row-actions-trigger"]');
  await act(async () => {
    (triggers[n] as HTMLElement).click();
  });
  await flush();
}

// story #3734(카디르 CI 적발) — content/page.test.tsx(site-posts)와 동형(그 파일
// 주석 참조 — `?`가 항상 템플릿 안에 있어 기본 뷰도 트레일링 빈 `?`를 붙인다).
function stripTrailingBareQuery(url: string): string {
  return url.endsWith('?') ? url.slice(0, -1) : url;
}

function stubFetch(
  drafts: unknown[] | { status: number },
  connections: unknown[] = ONE_ACTIVE_CONNECTION,
  meta: { total: number | null } | null = null,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = stripTrailingBareQuery(String(input));
      if (url === `/api/organizations/${ORG_ID}/channel-connections`) {
        return { ok: true, status: 200, json: async () => ({ data: connections, error: null, meta: null }) };
      }
      if (url === `/api/organizations/${ORG_ID}/channel-posts/drafts`) {
        if (!Array.isArray(drafts)) return { ok: false, status: drafts.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: drafts, error: null, meta }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
}

// story #3734 — content/page.test.tsx(site-posts)의 stubFetchStateful과 동형(그 파일
// 주석 참조) — 토글·액션 클릭의 실제 왕복까지 검증한다.
function stubFetchStateful(initial: Array<Record<string, unknown> & { draft_id: string; is_deleted?: boolean }>) {
  const state = new Map(initial.map((d) => [d.draft_id, { ...d }]));
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = String(input);
      calls.push(`${init?.method ?? 'GET'} ${rawUrl}`);
      const url = stripTrailingBareQuery(rawUrl);
      if (url === `/api/organizations/${ORG_ID}/channel-connections`) {
        return { ok: true, status: 200, json: async () => ({ data: ONE_ACTIVE_CONNECTION, error: null, meta: null }) };
      }
      const listBase = `/api/organizations/${ORG_ID}/channel-posts/drafts`;
      if (url === listBase || url === `${listBase}?include_deleted=true`) {
        const includeDeleted = url.includes('include_deleted=true');
        const rows = [...state.values()].filter((d) => includeDeleted || !d.is_deleted);
        return { ok: true, status: 200, json: async () => ({ data: rows, error: null, meta: null }) };
      }
      const actionMatch = /\/channel-posts\/drafts\/([^/]+)\/(archive|restore)$/.exec(url);
      if (actionMatch && init?.method === 'POST') {
        const [, draftId, action] = actionMatch;
        const draft = state.get(draftId);
        if (!draft) return { ok: false, status: 404, json: async () => ({}) };
        draft.is_deleted = action === 'archive';
        return { ok: true, status: 200, json: async () => ({ data: { draft_id: draftId, is_deleted: draft.is_deleted }, error: null, meta: null }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
  );
  return { state, calls };
}

const DRAFT_A = {
  draft_id: 'd1', work_item_id: 'w1', channel: 'threads', connection_id: 'c1',
  current_version: 2, latest_author_kind: 'human', updated_at: '2026-09-03T03:52:00+00:00',
  body_sha256: 'h1', gate_status: null, reapproval_required: null, sealed_content_sha256: null,
  published_at: null, publication_status: null,
};

describe('ChannelPostListPage (story #3402)', () => {
  it('0건 — 빈 상태(EmptyState) 안내(doc §2 — "새 글" 버튼 없음)', async () => {
    stubFetch([]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.channelPostsEmptyTitle);
    // AC(doc §2) — 빈 상태에 "새 글 작성" 류 CTA가 없다(에이전트 전용 생성 경로).
    expect(container.textContent).not.toContain('새 글');
  });

  // story #3422 ③-b(페드루 CHANGES Ⓑ, 시안 v6 — 목록/캘린더 뷰 전환은 탭 줄 위 stock
  // Tabs로) — 캘린더 전환은 이제 Link가 아니라 Tabs onValueChange로 라우팅한다.
  it('⭐목록/캘린더 전환에서 「캘린더」를 클릭하면 /content/channel-posts/calendar로 이동한다(0건이어도 항상 보인다)', async () => {
    stubFetch([]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    const calendarTab = container.querySelector('[data-testid="channel-posts-calendar-link"]') as HTMLElement;
    expect(calendarTab).not.toBeNull();
    await act(async () => { calendarTab.click(); });
    await flush();

    expect(routerPushMock).toHaveBeenCalledWith('/content/channel-posts/calendar');
  });

  // story #3744(유나 픽셀 CHANGES②·PO 채택, 2026-09-09 12:33Z) — 세그먼트 명사 짝은
  // docs.indexViewList="목록" 선례처럼 맨 낱말이어야 한다. channelPostsCalendarLinkCta
  // ("캘린더로 보기")는 이 세그먼트 하나뿐이던 소비처가 사라져 키 자체를 지웠다 —
  // channelPostsViewCalendar("캘린더")로 교체.
  it('⭐세그먼트 라벨이 「목록」·「캘린더」(맨 낱말, "로 보기" 없음)다', async () => {
    stubFetch([]);
    await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
    await flush();

    const listTab = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent === koMessages.content.channelPostsViewList);
    const calendarTab = container.querySelector('[data-testid="channel-posts-calendar-link"]');
    expect(listTab).toBeTruthy();
    expect(calendarTab?.textContent).toBe(koMessages.content.channelPostsViewCalendar);
    expect(calendarTab?.textContent).not.toContain('로 보기');
  });

  // story f30da19a AC5 — T1(목록).
  it('⭐AC5 — channel=sandbox면 칩 옆에 「테스트」 배지가 뜬다', async () => {
    stubFetch([{ ...DRAFT_A, channel: 'sandbox' }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')?.textContent)
      .toBe(koMessages.content.channelPostsSandboxTestBadge);
  });

  it('AC5 — channel=threads(실채널)면 배지가 없다', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')).toBeNull();
  });

  it('⭐목록 응답의 채널·버전·작성 주체·수정 시각이 화면에 그대로 나온다(AC1)', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.channelThreads);
    expect(container.textContent).toContain('v2');
    // story #3744 — 원작성 주체는 최종수정과 같으면 부제로 강등돼 안 보인다(content/
    // page.tsx와 동형 판단) — latest_author_kind='human'만 있고 origin은 없어 이
    // 문구는 상태 칸 하위 부제(최종수정 시각)로만 나온다. authorHuman 텍스트 자체는
    // origin_author_kind가 없으므로 이 목록엔 없다 — 이 테스트는 상태 칩 렌더로 대체.
    expect(container.querySelector('[data-status-chip]')).not.toBeNull();
  });

  it('⭐게이트/발행 신호가 전부 null인 행 — "초안" 상태로 렌더된다', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('draft');
  });

  it('⭐AC2 — gate_status 계약 필드 자체가 없는 행(구 계약)은 상태를 단정하지 않고 「—」를 그린다', async () => {
    const { gate_status: _drop, ...withoutGateContract } = DRAFT_A;
    stubFetch([withoutGateContract]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')).toBeNull();
  });

  it('⭐AC3 핵심 — publication_status=container_created(부분 성공)이 5상태 파생과 독립적으로 보인다', async () => {
    stubFetch([{
      ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
      publication_status: 'container_created',
    }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('approved');
    expect(container.querySelector('[data-testid="channel-post-partial-success"]')).not.toBeNull();
    expect(container.textContent).toContain(koMessages.content.channelPostsPartialSuccess);
  });

  it('publication_status=published(정상 발행) — 부분성공/실패 배지가 둘 다 안 보인다(회귀 방지)', async () => {
    stubFetch([{
      ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
      publication_status: 'published', published_at: '2026-09-03T18:44:00Z',
    }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.querySelector('[data-testid="channel-post-partial-success"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
    expect(container.querySelector('[data-status-chip]')?.getAttribute('data-status-chip')).toBe('published');
  });

  // story #3744(유나 CHANGES⑤·PO 채택, 2026-09-09) — 목록의 손코딩 빨간 알약(publication_
  // status==='failed' 불린 하나)을 [draftId]/page.tsx·ChannelPostCard가 이미 쓰는
  // FailureActionBadge(6갈래)로 통일. 계약은 publication_status가 아니라 command_status
  // 축(deriveFailureAction, failure-action.ts) — 두 축을 헷갈리면 안 되므로 별도 describe.
  describe('실패 표시 = FailureActionBadge 재사용(story #3744, 유나 CHANGES⑤)', () => {
    it('⭐command_status=dead_letter — 실패 배지(수동 재시도 문구)가 보인다', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1', command_status: 'dead_letter' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const badge = container.querySelector('[data-testid="channel-post-failure-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain(koMessages.content.channelPostsFailureDeadLetter);
    });

    it('⭐command_status=blocked — 사유만(버튼 0, §17-13 규율 그대로)', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1', command_status: 'blocked' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const badge = container.querySelector('[data-testid="channel-post-failure-badge"]');
      expect(badge?.textContent).toBe(koMessages.content.channelPostsFailureBlocked);
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    });

    // 페드루 실측(2026-09-09, PR 코멘트) — "processing만으로 빨갛게 칠하진 않는다".
    // 실패 뒤 재시도가 진행 중(command_status=pending ∧ processing_kind=awaiting_
    // container)이면 목록도 상세와 똑같이 "진행 중"(중립)이어야지 「실패」로 남으면
    // 안 된다 — publication_status가 아직 'failed'여도(재시도가 성공하기 前) 이
    // 배지는 command_status 축으로 판단하므로 안 갈린다. 뮤테이션 표적.
    it('⭐재시도가 processing 중이면(command_status=pending·processing_kind=awaiting_container) 빨간 실패 배지가 아니라 중립 "진행 중" 문구(§17-15, 뮤테이션 표적)', async () => {
      stubFetch([{
        ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
        publication_status: 'failed', command_status: 'pending', processing_kind: 'awaiting_container',
      }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const badge = container.querySelector('[data-testid="channel-post-failure-badge"]');
      expect(badge?.textContent).toBe(koMessages.content.channelPostsFailureProcessing);
    });

    it('command_status 계약 필드 자체가 없음(구 계약) — 배지를 안 그린다(지어내지 않음)', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1', publication_status: 'failed' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
    });
  });

  // story #3402(PO 지시 2026-09-04) — text_preview는 디디군 후속 PR로 곧 착지. 착지
  // 前(지금)엔 응답에 필드 자체가 없다 — 첫 열 링크는 channel+version으로 폴백한다
  // (navigable 유지). text_length 표시(부제)는 페드루 CHANGES Ⓒ(시안 v6)로 걷었다 —
  // 이 테스트는 이제 첫 열 폴백만 pin한다.
  it('⭐text_preview 계약 필드 부재(착지 前) — 첫 열은 channel+version 폴백', async () => {
    stubFetch([DRAFT_A]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(`${koMessages.content.channelThreads} · v2`);
  });

  it('⭐text_preview 계약 필드 존재(착지 後) — 본문 미리보기가 첫 열에 보인다', async () => {
    stubFetch([{ ...DRAFT_A, text_preview: '마케팅 자동화가 실제로 아끼는 시간은…', text_length: 363 }]);
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain('마케팅 자동화가 실제로 아끼는 시간은…');
  });

  it('로드 실패 — 오류 알림을 보인다', async () => {
    stubFetch({ status: 500 });
    await act(async () => {
      root.render(wrap(<ChannelPostListPage />));
    });
    await flush();

    expect(container.textContent).toContain(koMessages.content.channelPostsLoadFailed);
  });

  // story #3744 — 예약 시각 열(scheduled_at).
  // story #3744(유나 픽셀 CHANGES①·PO 채택, 2026-09-09 12:33Z) — 「나가는 시각」 칸이
  // 「언제 나가나」의 답을 전부 쥔다: 예약 없음=「—」/발행됨=published_at/막힘=배지
  // (우선순위 — 막힘이 최우선, 그다음 발행, 그다음 예약, 마지막 「—」). 「—」는 이제
  // "아직 예약 없음" 한 뜻만(예전엔 막힘·발행 여부를 몰라서도 "—"였다).
  describe('나가는 시각(story #3744, ① 픽셀 CHANGES — 우선순위 4단)', () => {
    // 3번째 <td>(0-index 2)가 「나가는 시각」 칸 — 글·채널·나가는 시각·상태·⋯.
    function outgoingCell() {
      return container.querySelectorAll('[data-testid="channel-posts-list-row"] td')[2];
    }

    it('⭐scheduled_at만 있음(막힘·발행 없음) — 예약 시각이 그 칸에 뜬다', async () => {
      stubFetch([{ ...DRAFT_A, scheduled_at: '2026-09-15T09:00:00+00:00' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(outgoingCell()?.textContent).toContain('09-15');
    });

    it('scheduled_at 없음(막힘·발행도 없음) — 「—」로 떨어진다(지어내지 않음)', async () => {
      stubFetch([DRAFT_A]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(outgoingCell()?.textContent).toBe('—');
    });

    it('⭐published_at 있음(막힘 없음) — published_at이 그 칸에 뜬다(scheduled_at과 별개 필드)', async () => {
      stubFetch([{
        ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
        publication_status: 'published', published_at: '2026-09-20T03:00:00+00:00',
      }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(outgoingCell()?.textContent).toContain('09-20');
    });

    it('⭐막힘(command_status=dead_letter) — FailureActionBadge가 「나가는 시각」 칸에 뜬다(제목 칸이 아니라)', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1', command_status: 'dead_letter' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const badge = outgoingCell()?.querySelector('[data-testid="channel-post-failure-badge"]');
      expect(badge).not.toBeNull();
      // 첫 번째(글) 칸엔 이제 배지가 없어야 한다 — 자리를 옮겼지 두 곳에 안 둔다.
      const titleCell = container.querySelectorAll('[data-testid="channel-posts-list-row"] td')[0];
      expect(titleCell?.querySelector('[data-testid="channel-post-failure-badge"]')).toBeNull();
    });

    // 뮤테이션 표적 — 우선순위를 어기면(예: published_at을 막힘보다 앞에 두면) 이 값이
    // 배지가 아니라 시각 문자열로 나와 실패해야 한다.
    it('⭐막힘 + published_at 둘 다 있음 — 막힘이 이긴다(우선순위, 뮤테이션 표적)', async () => {
      stubFetch([{
        ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
        command_status: 'dead_letter', published_at: '2026-09-20T03:00:00+00:00',
      }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(outgoingCell()?.querySelector('[data-testid="channel-post-failure-badge"]')).not.toBeNull();
      expect(outgoingCell()?.textContent).not.toContain('09-20');
    });
  });

  // story #3744(PO 決, 유나 코드 실측 정정) — 활성 채널 연결 0 빈 상태 갈래.
  describe('채널 연결 0 빈 상태(story #3744)', () => {
    it('⭐활성 연결 0 — 「연결된 채널이 없습니다」+「채널 연결」 액션을 그리고 목록 자체는 안 그린다', async () => {
      stubFetch([DRAFT_A], []);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(container.textContent).toContain(koMessages.content.channelPostsNoChannelsTitle);
      expect(container.textContent).toContain(koMessages.content.channelPostsNoChannelsListDescription);
      const action = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/organization/channels');
      expect(action).toBeTruthy();
      // 유나 CHANGES(2026-09-09, PO 채택) — orgChannels는 nav 네임스페이스 키인데
      // t('orgChannels')(content 네임스페이스)로 잘못 부르면 next-intl이 키를 못 찾아
      // 원문 키 문자열("orgChannels")이 그대로 화면에 찍힌다. tNav로 정정한 값
      // (koMessages.nav.orgChannels="채널 연결")이 실제로 뜨는지 정확한 문자열로 pin.
      expect(action?.textContent).toBe(koMessages.nav.orgChannels);
      expect(action?.textContent).not.toBe('orgChannels');
      expect(container.querySelector('[data-testid="channel-posts-list-row"]')).toBeNull();
    });

    // 뮤테이션 표적 — status 필터를 지우고 "연결이 하나라도 있으면 통과"로 바꾸면 이
    // 테스트가 실패해야 한다(expired만 있는 경우도 「활성 연결 0」이어야 한다).
    it('연결은 있지만 전부 expired/revoked — 여전히 「연결 0」 갈래(뮤테이션 표적)', async () => {
      stubFetch([DRAFT_A], [{ id: 'c1', status: 'expired' }, { id: 'c2', status: 'revoked' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(container.textContent).toContain(koMessages.content.channelPostsNoChannelsTitle);
    });

    it('활성 연결 1개 이상 — 정상 목록을 그린다(빈 상태 갈래 아님)', async () => {
      stubFetch([DRAFT_A], [{ id: 'c1', status: 'expired' }, { id: 'c2', status: 'active' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(container.textContent).not.toContain(koMessages.content.channelPostsNoChannelsTitle);
      expect(container.querySelector('[data-testid="channel-posts-list-row"]')).not.toBeNull();
    });
  });

  // 유나 CHANGES(2026-09-09, PO 채택) — content/page.test.tsx와 동형(그 파일 주석 참조).
  describe('상태 탭 5개 + 부분 상태 줄 억제(story #3744, 유나 CHANGES)', () => {
    it('⭐탭 5개가 전체·초안·승인 대기·승인됨·발행됨 순서로, contentStatus* 라벨 그대로 뜬다', async () => {
      stubFetch([DRAFT_A]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const labels = [...container.querySelectorAll('[data-testid="channel-posts-status-tabs"] [role="tab"]')].map((el) => el.textContent);
      expect(labels).toEqual([
        koMessages.content.statusTabAll,
        koMessages.content.contentStatusDraft,
        koMessages.content.contentStatusPending,
        koMessages.content.contentStatusApproved,
        koMessages.content.contentStatusPublished,
      ]);
    });

    it('⭐approved(미발행) 행은 「승인됨」 탭에 걸리고 「발행됨」 탭에는 안 걸린다(뮤테이션 표적)', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const publishedTab = [...container.querySelectorAll('[data-testid="channel-posts-status-tabs"] [role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusPublished,
      ) as HTMLElement;
      await act(async () => { publishedTab.click(); });
      await flush();
      expect(container.querySelector('[data-testid="channel-posts-list-row"]')).toBeNull();

      const approvedTab = [...container.querySelectorAll('[data-testid="channel-posts-status-tabs"] [role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusApproved,
      ) as HTMLElement;
      await act(async () => { approvedTab.click(); });
      await flush();
      expect(container.querySelector('[data-testid="channel-posts-list-row"]')).not.toBeNull();
    });

    it('⭐탭이 「전체」가 아닌데 그 탭에 걸리는 행이 0이면 statusTabEmpty를 그린다', async () => {
      stubFetch([DRAFT_A]); // DRAFT_A는 초안 상태
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const publishedTab = [...container.querySelectorAll('[data-testid="channel-posts-status-tabs"] [role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusPublished,
      ) as HTMLElement;
      await act(async () => { publishedTab.click(); });
      await flush();

      expect(container.textContent).toContain(koMessages.content.statusTabEmpty);
    });

    it('⭐탭이 「전체」가 아니면 total이 있어도 부분 상태 줄을 안 그린다(뮤테이션 표적)', async () => {
      stubFetch([DRAFT_A], ONE_ACTIVE_CONNECTION, { total: 5 });
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-posts-partial-state"]')).not.toBeNull();

      const draftTab = [...container.querySelectorAll('[data-testid="channel-posts-status-tabs"] [role="tab"]')].find(
        (el) => el.textContent === koMessages.content.contentStatusDraft,
      ) as HTMLElement;
      await act(async () => { draftTab.click(); });
      await flush();

      expect(container.querySelector('[data-testid="channel-posts-partial-state"]')).toBeNull();
    });
  });

  // story #3457 후속(유나 §14-2 안전 표기, PO 확定 2026-09-04 20:54Z) — 캘린더 카드·목록
  // 행·상세 3곳이 같은 어휘. 목록 행은 파생 표기만(배지는 상세 전용, 유나 정본).
  describe('같은 스토리의 글(목록 행, §14-2)', () => {
    it('source_content_item_id가 없으면(정상값) 이 줄 자체가 안 그려진다', async () => {
      stubFetch([DRAFT_A]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      expect(container.querySelector('[data-testid="channel-post-source-link"]')).toBeNull();
    });

    it('⭐source_title이 있으면 "같은 스토리의 글" 링크가 행 안에 보인다', async () => {
      stubFetch([{ ...DRAFT_A, source_content_item_id: 'site-1', source_title: '9월 실험 회고' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const el = container.querySelector('[data-testid="channel-post-source-link"]');
      expect(el?.textContent).toContain(koMessages.content.channelPostsSourceLabel);
      expect(el?.textContent).toContain('9월 실험 회고');
      expect(el?.querySelector('a')?.getAttribute('href')).toBe('/content/site-1');
    });
  });

  // story #3744(페드루 CHANGES Ⓐ, 시안 v6) — content/page.test.tsx와 동형(그 파일 주석
  // 참조 — 상태 뒤 다음 발은 ⋯ 메뉴 뒤에 숨지 않고 행에 상시 보이는 outline 버튼).
  describe('상태 뒤 다음 발(story #3744, Ⓐ 시안 v6 — 행에 상시 노출)', () => {
    it('⭐승인 대기 행 — 「승인 요청 보기」 버튼이 행에 상시 보이고 클릭 시 /inbox?tab=gates로 이동한다', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'pending' }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const button = [...container.querySelectorAll('button')].find(
        (el) => el.textContent === koMessages.content.approvalRequestViewCta,
      ) as HTMLElement;
      expect(button).toBeTruthy();
      await act(async () => { button.click(); });
      await flush();

      expect(routerPushMock).toHaveBeenCalledWith('/inbox?tab=gates');
    });

    it('⭐발행됨 행+permalink 있음 — 「채널에서 보기」 버튼이 행에 상시 보인다', async () => {
      stubFetch([{
        ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
        published_at: '2026-09-09T00:00:00Z', publication_status: 'published',
        permalink: 'https://threads.net/@x/post/1',
      }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const button = [...container.querySelectorAll('button')].find(
        (el) => el.textContent === koMessages.content.commentsReplyExternalLinkCta,
      );
      expect(button).toBeTruthy();
    });

    // 뮤테이션 표적 — permalink 가드를 지우면 실패해야 한다.
    it('발행됨 행이라도 permalink가 없으면 「채널에서 보기」 버튼이 안 뜬다(뮤테이션 표적)', async () => {
      stubFetch([{
        ...DRAFT_A, gate_status: 'approved', sealed_content_sha256: 'h1',
        published_at: '2026-09-09T00:00:00Z', publication_status: 'published', permalink: null,
      }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const button = [...container.querySelectorAll('button')].find(
        (el) => el.textContent === koMessages.content.commentsReplyExternalLinkCta,
      );
      expect(button).toBeUndefined();
    });

    // 뮤테이션 표적 — ⋯ 메뉴 안에 같은 라벨의 항목을 남겨 두면 이 테스트가 잡는다.
    it('⭐같은 동작을 ⋯ 메뉴에 중복해 두지 않는다 — 승인 대기 행의 ⋯ 메뉴엔 「승인 요청 보기」가 없다', async () => {
      stubFetch([{ ...DRAFT_A, gate_status: 'pending', can_archive: true }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      await openRowMenu();

      const menuItem = [...document.querySelectorAll('[role="menuitem"]')].find(
        (el) => el.textContent === koMessages.content.approvalRequestViewCta,
      );
      expect(menuItem).toBeUndefined();
      expect(document.querySelector('[data-testid="channel-post-archive-action"]')).not.toBeNull();
    });

    // §22-18 "유나의 자" — content/page.test.tsx와 동형(그 파일 주석 참조).
    it('⭐「승인 요청 보기」 버튼의 aria-label이 행 순번을 품어 두 행이 서로 다른 값을 갖는다(§22-18 처방 검증)', async () => {
      stubFetch([
        { ...DRAFT_A, draft_id: 'd1', gate_status: 'pending' },
        { ...DRAFT_A, draft_id: 'd2', gate_status: 'pending' },
      ]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const buttons = [...container.querySelectorAll('button')].filter(
        (el) => el.textContent === koMessages.content.approvalRequestViewCta,
      );
      expect(buttons).toHaveLength(2);
      const labels = buttons.map((b) => b.getAttribute('aria-label'));
      expect(labels[0]).not.toBeNull();
      expect(labels[0]).not.toBe(labels[1]);
      expect(labels[0]).toContain('1');
      expect(labels[1]).toContain('2');
    });
  });

  // story #3734 — content/page.test.tsx(site-posts)의 「보관」 describe와 동형.
  describe('보관(story #3734)', () => {
    it('⭐can_archive=false — ⋯ 메뉴에 「보관」 항목이 안 보인다(fail-closed)', async () => {
      stubFetch([{ ...DRAFT_A, can_archive: false }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      await openRowMenu();

      expect(document.querySelector('[data-testid="channel-post-archive-action"]')).toBeNull();
    });

    it('⭐can_archive=true — ⋯ 메뉴의 「보관」 클릭 시 POST .../archive 호출, 기본 목록에서 즉시 사라진다', async () => {
      const { state, calls } = stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      await openRowMenu();

      const button = document.querySelector('[data-testid="channel-post-archive-action"]') as HTMLElement;
      expect(button.textContent).toBe(koMessages.content.archiveAction);
      await act(async () => { button.click(); });
      await flush();

      expect(calls).toContain(`POST /api/organizations/${ORG_ID}/channel-posts/drafts/d1/archive`);
      expect(state.get('d1')?.is_deleted).toBe(true);
      expect(container.querySelector('[data-testid="channel-posts-list-row"]')).toBeNull();
    });

    it('⭐「보관됨 보기」 토글 — include_deleted=true로 재조회해 「보관됨」 배지·⋯ 메뉴에 「보관 해제」가 보인다', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: true }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      expect(container.textContent).toContain(koMessages.content.channelPostsEmptyTitle);

      const toggle = container.querySelector('[data-testid="channel-posts-show-archived-toggle"]') as HTMLButtonElement;
      expect(toggle.textContent).toBe(koMessages.content.showArchivedToggle);
      await act(async () => { toggle.click(); });
      await flush();

      expect(toggle.textContent).toBe(koMessages.content.hideArchivedToggle);
      expect(container.querySelector('[data-testid="channel-post-archived-badge"]')?.textContent).toBe(
        koMessages.content.contentStatusArchived,
      );
      await openRowMenu();
      expect(document.querySelector('[data-testid="channel-post-archive-action"]')?.textContent).toBe(
        koMessages.content.unarchiveAction,
      );
    });

    it('⭐「보관됨 보기」 뷰에서 아직 안 보관된 행을 ⋯ 메뉴에서 「보관」 클릭 — 행은 그대로 남고 배지·항목이 뒤집힌다(뮤테이션 표적)', async () => {
      const { state, calls } = stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      const toggle = container.querySelector('[data-testid="channel-posts-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => { toggle.click(); });
      await flush();
      await openRowMenu();

      const archiveButton = document.querySelector('[data-testid="channel-post-archive-action"]') as HTMLElement;
      expect(archiveButton.textContent).toBe(koMessages.content.archiveAction);
      await act(async () => { archiveButton.click(); });
      await flush();

      expect(calls).toContain(`POST /api/organizations/${ORG_ID}/channel-posts/drafts/d1/archive`);
      expect(state.get('d1')?.is_deleted).toBe(true);
      expect(container.querySelector('[data-testid="channel-posts-list-row"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="channel-post-archived-badge"]')?.textContent).toBe(
        koMessages.content.contentStatusArchived,
      );
    });

    it('⭐「보관됨 보기」에서 ⋯ 메뉴의 「보관 해제」 클릭 — 행은 목록에 남고 배지·항목만 뒤집힌다(include_deleted=true는 "포함", "전용" 아님)', async () => {
      const { state, calls } = stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: true }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      const toggle = container.querySelector('[data-testid="channel-posts-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => { toggle.click(); });
      await flush();
      await openRowMenu();

      const restoreButton = document.querySelector('[data-testid="channel-post-archive-action"]') as HTMLElement;
      await act(async () => { restoreButton.click(); });
      await flush();

      expect(calls).toContain(`POST /api/organizations/${ORG_ID}/channel-posts/drafts/d1/restore`);
      expect(state.get('d1')?.is_deleted).toBe(false);
      expect(container.querySelector('[data-testid="channel-posts-list-row"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="channel-post-archived-badge"]')).toBeNull();
    });

    // content/page.test.tsx(site-posts)와 동형 — §22-18 처방 검증.
    it('⭐⋯ 메뉴 트리거의 aria-label이 행 순번을 품어 두 행이 서로 다른 값을 갖는다(§22-18 처방 검증)', async () => {
      stubFetch([
        { ...DRAFT_A, draft_id: 'd1', can_archive: true },
        { ...DRAFT_A, draft_id: 'd2', can_archive: true },
      ]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();

      const triggers = container.querySelectorAll('[data-testid="channel-post-row-actions-trigger"]');
      expect(triggers).toHaveLength(2);
      const labels = [...triggers].map((b) => b.getAttribute('aria-label'));
      expect(labels[0]).not.toBeNull();
      expect(labels[0]).not.toBe(labels[1]);
      expect(labels[0]).toContain('1');
      expect(labels[1]).toContain('2');
    });

    it('⭐⋯ 메뉴의 「보관」 클릭 — 「보관했습니다」 토스트가 뜨고, 그 액션 클릭 시 「보관됨 보기」로 전환된다', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      await openRowMenu();

      const button = document.querySelector('[data-testid="channel-post-archive-action"]') as HTMLElement;
      await act(async () => { button.click(); });
      await flush();

      expect(container.textContent).toContain(koMessages.content.archivedToast);
      const toastActionButtons = [...container.querySelectorAll('button')].filter(
        (b) => b.textContent === koMessages.content.showArchivedToggle,
      );
      expect(toastActionButtons.length).toBeGreaterThanOrEqual(1);

      const toastAction = toastActionButtons[toastActionButtons.length - 1];
      await act(async () => { toastAction.click(); });
      await flush();

      expect(container.querySelector('[data-testid="channel-posts-show-archived-toggle"]')?.textContent).toBe(
        koMessages.content.hideArchivedToggle,
      );
    });

    it('⭐⋯ 메뉴에서 「보관 해제」(restore) 클릭 — 토스트가 안 뜬다', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: true }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      const toggle = container.querySelector('[data-testid="channel-posts-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => { toggle.click(); });
      await flush();
      await openRowMenu();

      const restoreButton = document.querySelector('[data-testid="channel-post-archive-action"]') as HTMLElement;
      await act(async () => { restoreButton.click(); });
      await flush();

      expect(container.textContent).not.toContain(koMessages.content.archivedToast);
    });

    // PO 추가(08:12Z) — content/page.test.tsx(site-posts)와 동형(그 파일 주석 참조).
    it('⭐「보관됨 보기」가 이미 켜진 상태에서 ⋯ 메뉴의 「보관」 클릭 — 토스트는 뜨지만 액션 버튼은 없다(PO 추가 08:12Z)', async () => {
      stubFetchStateful([{ ...DRAFT_A, can_archive: true, is_deleted: false }]);
      await act(async () => { root.render(wrap(<ChannelPostListPage />)); });
      await flush();
      const toggle = container.querySelector('[data-testid="channel-posts-show-archived-toggle"]') as HTMLButtonElement;
      await act(async () => { toggle.click(); });
      await flush();
      await openRowMenu();

      const archiveButton = document.querySelector('[data-testid="channel-post-archive-action"]') as HTMLElement;
      await act(async () => { archiveButton.click(); });
      await flush();

      expect(container.textContent).toContain(koMessages.content.archivedToast);
      const showArchivedLabelButtons = [...container.querySelectorAll('button')].filter(
        (b) => b.textContent === koMessages.content.showArchivedToggle,
      );
      expect(showArchivedLabelButtons.length).toBe(0);
    });
  });
});
