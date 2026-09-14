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
  await act(async () => { root.render(wrap(<OrgBriefingShell />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
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
    expect(h1?.textContent).toBe('오늘');
    expect(container.textContent).not.toContain('조직 브리핑');
    expect(container.textContent).not.toContain('오늘 조직의 지금');
  });

  it('사람 손이 필요한 일이 있으면 헤더 배지가 뜬다', async () => {
    stubToday({ ...EMPTY_TODAY, needs_me_count: 3 });
    await mount();
    const badge = container.querySelector('[data-testid="needs-me-header-badge"]');
    expect(badge?.textContent).toBe('사람 손이 필요한 일 3');
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
  it('?next= 있으면 복귀 안내 배너를 보여준다', async () => {
    searchParamsValueRef.current = 'next=%2Fboard';
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).toContain('프로젝트를 선택하면 원래 보려던 화면으로 이동해요.');
  });

  it('?next= 없으면 project 유무와 무관하게 배너가 안 뜬다(today는 org 스코프)', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).not.toContain('프로젝트를 선택하면');
  });
});

describe('OrgBriefingShell — story #3831 AC1(3구역, 3823 route 단일 소비)', () => {
  it('오늘 내 결정 항목이 있으면 제목·상태·행동 버튼이 뜬다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      needs_me: [{
        kind: 'signature', risk: 'high', source: 'gate', source_id: 'g1',
        work_item: { type: 'story', id: 's1', title: 'Threads에 글 발행' },
        requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
      }],
      needs_me_count: 1,
    });
    await mount();
    expect(container.textContent).toContain('Threads에 글 발행');
    expect(container.textContent).toContain('서명 대기');
    expect(container.textContent).toContain('승인하고 서명');
    expect(container.textContent).toContain('외부로 나가요 — 되돌릴 수 없어요');
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === '승인하고 서명');
    expect(link?.getAttribute('href')).toBe('/gates/g1');
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

  it('에이전트 진행 항목이 있으면 이름·상태가 뜬다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      agent_progress: [{
        run_id: 'r1', agent: { id: 'a1', name: '미르코' },
        work_item: { type: 'story', id: 's1', title: 'YouTube 영상 올리기' },
        status: 'running', current_step: null, started_at: '2026-09-13T03:00:00Z',
      }],
    });
    await mount();
    expect(container.textContent).toContain('YouTube 영상 올리기');
    expect(container.textContent).toContain('미르코');
    expect(container.textContent).toContain('진행 중 1');
  });

  it('에이전트 진행이 0건이면 「진행 중인 위임이 없어요」', async () => {
    stubToday(EMPTY_TODAY);
    await mount();
    expect(container.textContent).toContain('진행 중인 위임이 없어요');
  });

  // 페드루 PO CHANGES(2026-09-14 00:32Z, PR #4256) — AGENT_STATUS_KEY 표에 없는 status를
  // 「진행 중」으로 단정하면 지어내는 것(no-fiction). 상태 낱말 자체가 없어야 한다.
  it('agent_progress.status가 표에 없는 값이면 상태 낱말을 지어내지 않는다(에이전트 이름만)', async () => {
    stubToday({
      ...EMPTY_TODAY,
      agent_progress: [{
        run_id: 'r1', agent: { id: 'a1', name: '미르코' },
        work_item: { type: 'story', id: 's1', title: 'YouTube 영상 올리기' },
        status: 'unknown_future_status', current_step: null, started_at: '2026-09-13T03:00:00Z',
      }],
    });
    await mount();
    // 섹션 헤더 배지("진행 중 1")는 건수 낱말이라 무관 — 행 자신의 부제(agentName·status)만
    // 검사한다: status 인식 실패면 그 줄이 에이전트 이름 하나로 끝나야 한다("· 진행 중" 0).
    const nameSpan = [...container.querySelectorAll('span')].find((s) => s.textContent === '미르코');
    expect(nameSpan).toBeTruthy();
  });

  it('오늘 나간 것이 있으면 채널별 수가 뜬다', async () => {
    stubToday({
      ...EMPTY_TODAY,
      published_today: { count: 3, by_channel: [{ channel_kind: 'blog', count: 2 }, { channel_kind: 'newsletter', count: 1 }] },
    });
    await mount();
    expect(container.textContent).toContain('나간 것');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('blog 2 · newsletter 1');
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
