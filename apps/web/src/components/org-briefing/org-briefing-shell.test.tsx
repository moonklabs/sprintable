// @vitest-environment jsdom
//
// story #3831(UX-v3·FE 3·오늘) — OrgBriefingShell을 옛 조직 브리핑(3면 NowFace·LoopFace·
// WorkforceFace)에서 시안 v3(오늘 1caf61fe)로 흡수한 회귀가드. 수의 출처는 story #3823
// `GET /api/v2/today` 단 하나(자체 집계 0) — 실 fetch를 스텁해 그 계약대로 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CHAT_API_PREFIX } from '@/lib/chat-api-prefix';

const { useDashboardContextMock, searchParamsValueRef, pushMock, replaceMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  searchParamsValueRef: { current: '' as string },
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
  usePathname: () => '/org-briefing',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchParamsValueRef.current = '';
  pushMock.mockReset();
  replaceMock.mockReset();
  useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubToday(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/today') {
      return { ok: true, status: 200, json: async () => ({ data: payload }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  }));
}

async function mount() {
  const { OrgBriefingShell } = await import('./org-briefing-shell');
  // story #4888 — the home reads the shared home model (the shell mounts the provider; this test mounts it itself, with no member and no project: only the today snapshot is read)
  const { HomeModelProvider } = await import('@/components/home/home-model-provider');
  await act(async () => { root.render(wrap(<HomeModelProvider viewerMemberId={null} projectId={undefined}><OrgBriefingShell /></HomeModelProvider>)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function openFolded(label: string) {
  const section = container.querySelector(`section[aria-label="${label}"]`);
  const toggle = section?.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
  expect(toggle, `«${label}» 구역은 처음엔 접혀 있다`).toBeTruthy();
  await act(async () => { toggle!.click(); });
}

const EMPTY_TODAY = {
  needs_me: [], needs_me_count: 0, agent_progress: [],
  published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
};

describe('OrgBriefingShell — story #3831 헤더(옛 조직 브리핑 낱말 0)', () => {
  it('h1은 「오늘」이다(옛 "조직 브리핑"/greeting 낱말 0)', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('홈');
    expect(container.textContent).not.toContain('조직 브리핑');
    expect(container.textContent).not.toContain('오늘 조직의 지금');
  });

  it('사람 손이 필요한 일이 있으면 헤더 배지가 뜬다 — 수는 «내 손이 필요해요» 구역의 행 수(= 막대 배지)다', async () => {
    const rows = ['g1', 'g2', 'g3'].map((id) => ({
      kind: 'approval', risk: 'low', source: 'gate', source_id: id,
      work_item: { type: 'story', id: `s-${id}`, title: `결재 ${id}` },
      requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
    }));
    stubToday({ ...EMPTY_TODAY, needs_me: rows, needs_me_count: 3 });
    await mount();
    const badge = container.querySelector('[data-testid="needs-me-header-badge"]');
    expect(badge?.getAttribute('data-kind')).toBe('needs-hand');
    expect(badge?.textContent).toContain('3');
    expect(container.querySelector('[data-testid="home-header-line"]')?.textContent).toBe('손 필요 3 · 진행 0 · 마침 0');
  });

  // 페드루 PO CHANGES(2026-09-14 00:32Z, PR #4256) — 헤더 배지와 구역 제목이 같은 낱말로
  // 통일됐다(옛 "오늘 내 결정" 제거) — 구역 제목은 count=0에도 항상 뜨므로 여기선 헤더
  // 배지(data-testid)만 부재를 확인한다(전체 textContent엔 구역 제목이 남아있는 게 정상).
  it('사람 손이 필요한 일이 0이면 헤더 배지가 안 뜬다', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.querySelector('[data-testid="needs-me-header-badge"]')).toBeNull();
  });
});

describe('OrgBriefingShell — 프로젝트 안내 배너(story #2212, story #3831로 축소)', () => {
  // story #3831 — today route는 org 스코프뿐(project_id 파라미터 자체가 없다) — project
  // 미보유 자체는 더는 배너 사유가 아니다(옛 "여기에 현황이 표시됩니다"는 이제 거짓이다,
  // LoopFace/WorkforceFace가 걷혀 project 유무와 화면 내용이 무관해졌으므로).
  it('?next= 있고 프로젝트를 안 골랐고 고를 프로젝트가 있으면 복귀 안내 배너를 보여준다', async () => {
    searchParamsValueRef.current = 'next=%2Fboard';
    useDashboardContextMock.mockReturnValue({ projectId: undefined, projectMemberships: [{ id: 'p1', name: 'P1' }], orgMemberships: [] });
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).toContain('프로젝트를 선택하면 원래 보려던 화면으로 이동해요.');
  });

  // story 4773 (AC2) — the banner says «pick a project»: true only when none is picked and one can be. The session restore puts `?next=/glance?_prRetry=1` on Today with the project already chosen
  // (4762 AC8 lap, dev 10-24: `?p=` on the page and on every flat link) — the line then sent the person looking for a choice already made.
  it('[4773] ?next= 가 있어도 프로젝트가 이미 골라졌으면(자동 선택 포함) 배너가 안 뜬다 — 세션 복원이 붙인 재시도 표식 next', async () => {
    searchParamsValueRef.current = 'next=%2Fglance%3F_prRetry%3D1&p=p1';
    useDashboardContextMock.mockReturnValue({ projectId: 'p1', projectMemberships: [{ id: 'p1', name: 'P1' }], orgMemberships: [] });
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).not.toContain('프로젝트를 선택하면'); // back to the old `next`-only condition → fails
  });

  it('[4773] 프로젝트가 둘 이상이고 아직 안 골랐으면 배너가 뜬다(맞는 말)', async () => {
    searchParamsValueRef.current = 'next=%2Fboard';
    useDashboardContextMock.mockReturnValue({ projectId: undefined, projectMemberships: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], orgMemberships: [] });
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).toContain('프로젝트를 선택하면 원래 보려던 화면으로 이동해요.');
  });

  it('[4773] 프로젝트가 하나도 없으면(고를 게 없음) next가 있어도 «고르세요» 배너가 안 뜬다', async () => {
    searchParamsValueRef.current = 'next=%2Fboard';
    useDashboardContextMock.mockReturnValue({ projectId: undefined, projectMemberships: [], orgMemberships: [] });
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).not.toContain('프로젝트를 선택하면'); // without the candidates condition → fails
  });

  it('?next= 없으면 project 유무와 무관하게 배너가 안 뜬다(today는 org 스코프)', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).not.toContain('프로젝트를 선택하면');
  });
});

describe('OrgBriefingShell — story #3831 AC1(3구역, 3823 route 단일 소비)', () => {
  it('오늘 내 결정 항목이 있으면 제목·상태·행동 버튼이 뜬다', async () => {
    stubToday({ ...EMPTY_TODAY, needs_me: [{
        kind: 'signature', risk: 'high', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: 'Threads에 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
      }], needs_me_count: 1 });
    await mount();
    expect(container.textContent).toContain('Threads에 글 발행');
    expect(container.textContent).toContain('서명 대기');
    expect(container.textContent).toContain('승인하고 서명');
    expect(container.textContent).toContain('외부로 나가요 — 되돌릴 수 없어요');
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === '승인하고 서명');
    expect(link?.getAttribute('href')).toBe('/gates/g1');
  });

  // story #4888 — the old pill / button class checks (amber `bg-warning-tint`, `bg-primary`) belonged to the old Badge / Button. The home now draws the row with the new list row:
  // «needs a hand» is the row's own marker (+ a name for screen readers, never colour alone) and its action is the primary Button of the new set.
  it('손 필요 행은 «내 손이 필요» 표지(data-needs-hand + 화면에 안 보이는 이름)를 달고, 주 행동은 주 단추다', async () => {
    stubToday({ ...EMPTY_TODAY, needs_me: [{
        kind: 'signature', risk: 'high', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: 'Threads에 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
      }], needs_me_count: 1 });
    await mount();
    const row = container.querySelector('[data-row-key="gate:g1"] [data-slot="ds-list-row"]');
    expect(row?.getAttribute('data-needs-hand')).toBe('true');
    expect(row?.querySelector('.sr-only')?.textContent).toBe('내 손이 필요');
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === '승인하고 서명');
    expect(link?.className).toContain('bg-ds-action');
  });

  it('헤더 배지는 «내 손이 필요» 뜻의 배지다(색 하나에만 뜻을 싣지 않는다 — 안 보이는 이름이 같이 있다)', async () => {
    stubToday({ ...EMPTY_TODAY, needs_me: [{
        kind: 'signature', risk: 'high', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: 'Threads에 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
      }], needs_me_count: 1 });
    await mount();
    const badge = container.querySelector('[data-testid="needs-me-header-badge"]');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('data-kind')).toBe('needs-hand');
    expect(badge!.textContent).toContain('내 손이 필요');
  });

  it('오늘 내 결정이 0건이면 「모두 확인했어요」', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).toContain('모두 확인했어요');
  });

  // 페드루 PO CHANGES(2026-09-14 00:32Z, PR #4256) — needs_me_count(서버 집계) > 파싱된
  // 행 수(핵심 식별자 없어 뺀 뒤)면 그 차를 「모두 확인했어요」로 삼키지 않고 낱말로 드러낸다.
  it('needs_me_count가 파싱된 행 수보다 크면 숨겨진 건수를 알린다(0으로 위장 금지)', async () => {
    stubToday({
      ...EMPTY_TODAY,
      needs_me: [{
        kind: 'approval', risk: 'low', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: '블로그 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
      }],
      needs_me_count: 3, // 응답엔 3건이라는데 파싱 가능한 행은 1개뿐(나머지 2건은 식별자 결손).
    });
    await mount();
    expect(container.textContent).toContain('2건은 정보가 부족해 표시하지 못했어요');
    expect(container.textContent).not.toContain('모두 확인했어요');
  });

  it('needs_me_count는 3인데 파싱 가능한 행이 0개면(전부 식별자 결손) 「모두 확인했어요」로 위장하지 않는다', async () => {
    stubToday({ ...EMPTY_TODAY, needs_me: [], needs_me_count: 3 });
    await mount();
    expect(container.textContent).toContain('3건은 정보가 부족해 표시하지 못했어요');
    expect(container.textContent).not.toContain('모두 확인했어요');
  });

  it('에이전트 진행 항목이 있으면 이름·상태가 뜬다 — «일하는 중» 구역은 처음엔 접혀 있고 머리에 수가 있다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      agent_progress: [{
        run_id: 'r1', agent: { id: 'a1', name: '미르코' },
        work_item: { type: 'story', id: 's1', title: 'YouTube 영상 올리기' },
        status: 'running', current_step: null, started_at: '2026-09-13T03:00:00Z',
      }],
    });
    await mount();
    expect(container.textContent).not.toContain('YouTube 영상 올리기'); // folded
    expect(container.querySelector('section[aria-label="일하는 중"] [data-slot="ds-count-badge"]')?.textContent).toBe('1');
    await openFolded('일하는 중');
    expect(container.textContent).toContain('YouTube 영상 올리기');
    expect(container.textContent).toContain('미르코');
    expect(container.textContent).toContain('진행 중'); // the status word the old row had
  });

  it('에이전트 진행이 0건이면 «지금 하는 일이 없어요»', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    await openFolded('일하는 중');
    expect(container.textContent).toContain('지금 하는 일이 없어요');
  });

  // 페드루 PO CHANGES(2026-09-14 00:32Z, PR #4256) — a status the table does not know must not be said as «진행 중» (no-fiction). In the home the rule is stronger: deriveHome only lists
  // the statuses the backend itself counts as in progress, so an unknown one is not a «working» row at all (and no word is invented for a known one that has none).
  it('agent_progress.status가 표에 없는 값이면 «하는 중»으로 단정하지 않는다(행으로 올리지 않는다)', async () => {
    stubToday({
      ...EMPTY_TODAY,
      agent_progress: [{
        run_id: 'r1', agent: { id: 'a1', name: '미르코' },
        work_item: { type: 'story', id: 's1', title: 'YouTube 영상 올리기' },
        status: 'unknown_future_status', current_step: null, started_at: '2026-09-13T03:00:00Z',
      }],
    });
    await mount();
    expect(container.querySelector('section[aria-label="일하는 중"] [data-slot="ds-count-badge"]')?.textContent).toBe('0');
    await openFolded('일하는 중');
    expect(container.querySelector('[data-row-key="run:r1"]')).toBeNull();
    expect(container.textContent).not.toContain('YouTube 영상 올리기');
  });

  it('상태 낱말은 표에 있는 status에만 붙는다: 답 대기 중인 실행은 그 낱말을 단다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      agent_progress: [{
        run_id: 'r2', agent: { id: 'a1', name: '미르코' },
        work_item: { type: 'story', id: 's1', title: '영상 올리기' },
        status: 'hitl_pending', current_step: null, started_at: '2026-09-13T03:00:00Z',
      }],
    });
    await mount();
    await openFolded('일하는 중');
    expect(container.querySelector('[data-row-key="run:r2"]')?.textContent).toContain(koMessages.orgBriefing.agentStatusHitlPending);
  });

  it('오늘 나간 것이 있으면 채널별 수가 뜬다(표시명, raw channel_kind 아님)', async () => {
    stubToday({
      ...EMPTY_TODAY,
      published_today: { count: 3, by_channel: [{ channel_kind: 'hosted_site', count: 2 }, { channel_kind: 'stibee', count: 1 }] },
    });
    await mount();
    expect(container.textContent).toContain('나간 것');
    expect(container.textContent).toContain('3');
    // 페드루 PO CHANGES(2026-09-14 00:58Z) — channelLabel() 재사용 확인. raw 코드값
    // ("hosted_site"·"stibee")이 그대로 새면 안 된다.
    expect(container.textContent).toContain('Sprintable 블로그 2 · 스티비 1');
    expect(container.textContent).not.toContain('hosted_site');
    expect(container.textContent).not.toContain('stibee');
  });

  it('사용량 카드의 채널명도 표시명으로 뜬다(raw "youtube" 아님)', async () => {
    stubToday({
      ...EMPTY_TODAY,
      usage: {
        platform: [{ connection_id: 'c1', channel_kind: 'youtube', used: 100, limit: 10000, reset_at: '2026-09-14T00:00:00Z' }],
        ad_spend: { measured: false },
      },
    });
    await mount();
    const label = [...container.querySelectorAll('p')].find((p) => p.textContent === 'YouTube' || p.textContent === 'youtube');
    expect(label?.textContent).toBe('YouTube');
  });

  it('오늘 나간 것도 사용량도 0건이면 「오늘 나간 게 아직 없어요」', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).toContain('오늘 나간 게 아직 없어요');
  });

  it('나간 것이 있어 구역이 안 비어도, 광고비는 미측정으로 뜬다(0으로 안 그림)', async () => {
    stubToday({ ...EMPTY_TODAY, published_today: { count: 1, by_channel: [{ channel_kind: 'blog', count: 1 }] } });
    await mount();
    expect(container.textContent).toContain('미측정');
    expect(container.textContent).not.toMatch(/광고비[^가-힣]*0(?!,)/);
  });
});

describe('OrgBriefingShell — story #3831 AC4(conversation_id 있으면만 대화 열기)', () => {
  it('conversation_id가 없으면(현재 3823 응답 형상) 「대화 열기」 링크가 0개다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      needs_me: [{
        kind: 'approval', risk: 'low', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: '블로그 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
      }],
      needs_me_count: 1,
    });
    await mount();
    expect(container.textContent).not.toContain('대화 열기');
  });

  it('conversation_id가 있으면 「대화 열기」 링크가 그 대화로 간다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      needs_me: [{
        kind: 'approval', risk: 'low', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: '블로그 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
        conversation_id: 'conv-1',
      }],
      needs_me_count: 1,
    });
    await mount();
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === '대화 열기');
    expect(link?.getAttribute('href')).toBe('/chats/conv-1');
  });
});

describe('OrgBriefingShell — story #3831 지시 한 줄(PO 確定(c) 2026-09-13 14:04Z)', () => {
  it('보내기 → /chats?compose=<입력값>으로 라우팅한다(수신자 발명 0)', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '유튜브 챕터 3개로 나눠줘');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = input.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(pushMock).toHaveBeenCalledWith('/chats?compose=' + encodeURIComponent('유튜브 챕터 3개로 나눠줘'));
  });

  it('빈 값이면 보내기 버튼이 비활성이다', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === '보내기');
    expect(button?.disabled).toBe(true);
  });
});

// story #3831 후속(페드루 PO 確定, 2026-09-13 14:22Z, 3832 전역 단축키 카드와 맞물림) —
// 컴패니언이 단축키로 `?focus=compose` 딥링크를 열면 지시 한 줄에 바로 포커스하고, 그
// 쿼리는 소비 뒤 URL에서 지운다(뒤로가기·새로고침마다 재포커스되며 타이핑을 뺏지 않도록).
describe('OrgBriefingShell — story #3831 후속 ?focus=compose 딥링크(3832 컴패니언 단축키)', () => {
  it('?focus=compose로 열리면 지시 한 줄 입력이 포커스되고 쿼리가 지워진다', async () => {
    searchParamsValueRef.current = 'focus=compose';
    stubToday(EMPTY_TODAY);
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]');
    expect(document.activeElement).toBe(input);
    expect(pushMock).not.toHaveBeenCalled(); // replace를 쓴다(뒤로가기 스택에 안 쌓임).
  });

  it('?focus= 없이 열리면 포커스를 뺏지 않는다', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]');
    expect(document.activeElement).not.toBe(input);
  });
});

describe('OrgBriefingShell — 로드 실패(에러를 삼키지 않는다)', () => {
  it('fetch 실패면 에러 문구+다시 시도 버튼을 보여준다(0건으로 위장하지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
    expect(container.textContent).not.toContain('모두 확인했어요');
  });
});

// story #4762 (AC1 · AC3) — one press of the instruction line sends when the person has exactly one agent DM; the send button keeps clear of the support button.
describe('OrgBriefingShell — story #4762 AC1 한 번 누름 = 서버에 메시지', () => {
  const ME = 'me-1';
  const agentDm = (id: string, agent: string) => ({ id, type: 'dm', participants: [{ member_id: ME, type: 'human' }, { member_id: agent, type: 'agent' }] });
  let calls: Array<{ url: string; method: string; body?: string }>;

  function stubWorld(opts: { conversations: unknown[]; total?: number; sendOk?: boolean }) {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === '/api/today') return { ok: true, status: 200, json: async () => ({ data: EMPTY_TODAY }) };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => ({ data: opts.conversations, total: opts.total ?? opts.conversations.length }) };
      if (url.endsWith('/messages')) return opts.sendOk === false
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 201, json: async () => ({ data: { id: 'm1', content: 'x', created_by: ME, conversation_id: 'c1', sender: { id: ME, name: 'me', type: 'human' } } }) };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    }));
  }

  async function typeAndSend(text: string) {
    const input = container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    return input;
  }

  beforeEach(() => { useDashboardContextMock.mockReturnValue({ projectId: 'p1', currentTeamMemberId: ME, projectMemberships: [], orgMemberships: [] }); });

  it('exactly one agent DM → one POST of the text to it, then the person lands on that DM', async () => {
    stubWorld({ conversations: [agentDm('c1', 'a1')] });
    await mount();
    await typeAndSend('유튜브 챕터 3개로 나눠줘');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(`${CHAT_API_PREFIX}/c1/messages`); // the chat screen's own address (story #4762 — it was the old `/api/chats`, a 404 on dev)
    expect(JSON.parse(posts[0]!.body!).content).toBe('유튜브 챕터 3개로 나눠줘');
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/chats/c1?p=p1'); // the flat link carries the project, as every flat link does
    // what was sent is not left in the line (a back press must not offer it again as if unsent)
    expect((container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement).value).toBe('');
  });

  it('two agent DMs → nothing is sent, the old hand-over to the chat keeps working', async () => {
    stubWorld({ conversations: [agentDm('c1', 'a1'), agentDm('c2', 'a2')] });
    await mount();
    await typeAndSend('hi');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(pushMock).toHaveBeenCalledWith('/chats?compose=hi&p=p1');
  });

  it('a send the server refuses keeps the text, says so, and does not leave the screen', async () => {
    stubWorld({ conversations: [agentDm('c1', 'a1')], sendOk: false });
    await mount();
    const input = await typeAndSend('keep me');
    expect(container.querySelector('[data-testid="today-instruction-failed"]')?.textContent).toBe(koMessages.orgBriefing.instructionSendFailed);
    expect(input.value).toBe('keep me');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('no answer at all (network) says «check the chat first» — a different line than a refusal, the text stays, nobody is pushed', async () => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/today') return { ok: true, status: 200, json: async () => ({ data: EMPTY_TODAY }) };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => ({ data: [agentDm('c1', 'a1')], total: 1 }) };
      if (url.endsWith('/messages')) throw new TypeError('network down');
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    }));
    await mount();
    const input = await typeAndSend('maybe sent');
    expect(container.querySelector('[data-testid="today-instruction-failed"]')?.textContent).toBe(koMessages.orgBriefing.instructionSendUnknown);
    expect(input.value).toBe('maybe sent');
    expect(pushMock).not.toHaveBeenCalled();
    // the line is about the text that was there: the person editing it puts the line away (it never stays on an empty box)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(container.querySelector('[data-testid="today-instruction-failed"]')).toBeNull();
  });

  it('while sending, a second press does not send twice', async () => {
    stubWorld({ conversations: [agentDm('c1', 'a1')] });
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'once'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const form = input.closest('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('the person leaves the screen while the list is being read → nothing is sent', async () => {
    let release!: (v: unknown) => void;
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/today') return { ok: true, status: 200, json: async () => ({ data: EMPTY_TODAY }) };
      if (url.startsWith('/api/conversations?')) { await new Promise((r) => { release = r; }); return { ok: true, status: 200, json: async () => ({ data: [agentDm('c1', 'a1')], total: 1 }) }; }
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    }));
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'late'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { root.unmount(); });
    root = createRoot(container); // afterEach unmounts it
    await act(async () => { release(null); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('the person leaves the screen while the message is being sent → no state set, nowhere pushed (the message itself is sent)', async () => {
    let release!: (v: unknown) => void;
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/today') return { ok: true, status: 200, json: async () => ({ data: EMPTY_TODAY }) };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => ({ data: [agentDm('c1', 'a1')], total: 1 }) };
      if (url.endsWith('/messages')) { await new Promise((r) => { release = r; }); return { ok: true, status: 201, json: async () => ({ data: { id: 'm1', content: 'x', created_by: ME, conversation_id: 'c1', sender: { id: ME, name: 'me', type: 'human' } } }) }; }
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    }));
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'on its way'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 6 && !release; i += 1) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1); // the POST is in flight
    await act(async () => { root.unmount(); });
    root = createRoot(container); // afterEach unmounts it
    await act(async () => { release(null); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('the person moves to another project while the message is being sent → the line is cleared (it was sent) but they are not taken back to the project they left', async () => {
    let release!: (v: unknown) => void;
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/today') return { ok: true, status: 200, json: async () => ({ data: EMPTY_TODAY }) };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => ({ data: [agentDm('c1', 'a1')], total: 1 }) };
      if (url.endsWith('/messages')) { await new Promise((r) => { release = r; }); return { ok: true, status: 201, json: async () => ({ data: { id: 'm1', content: 'x', created_by: ME, conversation_id: 'c1', sender: { id: ME, name: 'me', type: 'human' } } }) }; }
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    }));
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'sent from p1'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    for (let i = 0; i < 6 && !release; i += 1) await act(async () => { await Promise.resolve(); });
    useDashboardContextMock.mockReturnValue({ projectId: 'p2', currentTeamMemberId: ME, projectMemberships: [], orgMemberships: [] });
    const { OrgBriefingShell } = await import('./org-briefing-shell');
    const { HomeModelProvider } = await import('@/components/home/home-model-provider');
    await act(async () => { root.render(wrap(<HomeModelProvider viewerMemberId={null} projectId={undefined}><OrgBriefingShell /></HomeModelProvider>)); });
    await act(async () => { release(null); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect((container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement).value).toBe('');
    // not silent: it IS sent, and the line says it went to the chat of the project the person was on
    const note = container.querySelector('[data-testid="today-instruction-failed"]');
    expect(note?.textContent).toBe(koMessages.orgBriefing.instructionSentElsewhere);
    expect(note?.getAttribute('role')).toBe('status');
  });

  it('the person is on another project when the list answers → nothing is sent to the project they left', async () => {
    let release!: (v: unknown) => void;
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/today') return { ok: true, status: 200, json: async () => ({ data: EMPTY_TODAY }) };
      if (url.startsWith('/api/conversations?')) { await new Promise((r) => { release = r; }); return { ok: true, status: 200, json: async () => ({ data: [agentDm('c1', 'a1')], total: 1 }) }; }
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    }));
    await mount();
    const input = container.querySelector('[data-testid="today-instruction-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'late'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    useDashboardContextMock.mockReturnValue({ projectId: 'p2', currentTeamMemberId: ME, projectMemberships: [], orgMemberships: [] });
    const { OrgBriefingShell } = await import('./org-briefing-shell');
    const { HomeModelProvider } = await import('@/components/home/home-model-provider');
    await act(async () => { root.render(wrap(<HomeModelProvider viewerMemberId={null} projectId={undefined}><OrgBriefingShell /></HomeModelProvider>)); }); // the same screen, re-rendered: the dashboard context now says project p2
    await act(async () => { release(null); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('without a project or a member id (not known yet) the old hand-over runs at once — no list read', async () => {
    useDashboardContextMock.mockReturnValue({ projectMemberships: [], orgMemberships: [] });
    stubWorld({ conversations: [agentDm('c1', 'a1')] });
    await mount();
    await typeAndSend('hi');
    expect(calls.some((c) => c.url.startsWith('/api/conversations'))).toBe(false);
    expect(pushMock).toHaveBeenCalledWith('/chats?compose=hi');
  });
});

describe('OrgBriefingShell — story #4762 AC3 지원 버튼이 [보내기]를 가리지 않는다', () => {
  it('the instruction row keeps the support button\'s corner free below lg (and gives it back from lg)', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    const form = container.querySelector('[data-testid="today-instruction-form"]') as HTMLElement;
    expect(form.className).toMatch(/(^|\s)pe-14(\s|$)/);
    expect(form.className).toMatch(/(^|\s)lg:pe-0(\s|$)/);
    // the input is w-full: a wrapping row would push [Send] to a second line (codex 4762) — one row, the failure line sits BELOW the form
    expect(form.className).not.toMatch(/flex-wrap/);
  });
});
