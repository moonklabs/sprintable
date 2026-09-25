// @vitest-environment jsdom
//
// story #2613(PR #2824 승계) — POST /api/conversations가 AGENT_MESSAGE_POLICY_DENIED
// 구조화 403으로 거부될 때 모달이 대상 에이전트·멤버·조치 안내(워크포스 딥링크)를 표시하는지
// 잰다(AC2). 그 외 실패(기존 generic 문구)는 회귀 없이 그대로인지도 함께 고정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NewConversationModal } from './new-conversation-modal';
import koMessages from '../../../messages/ko.json';

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

const PROJECT_ID = 'proj-1';
const MEMBERS = [
  { id: 'm-yuna', name: '유나', type: 'human' },
  { id: 'a-bot', name: '점검봇', type: 'agent' },
];

function mockFetches(onPost: (body: unknown) => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
    if (url === '/api/conversations' && init?.method === 'POST') {
      return onPost(JSON.parse(init.body!));
    }
    return { ok: true, json: async () => ({}) };
  });
}

async function mountAndSelect(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(wrap(<NewConversationModal projectId={PROJECT_ID} onClose={() => {}} onCreated={() => {}} />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const botBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('점검봇'))!;
  await act(async () => { botBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const createBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === koMessages.chats.create) as HTMLButtonElement;
  await act(async () => { createBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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

// story #3997(3994 후속, PO 確定) — 「시스템 발행」에게 DM을 여는 것 자체가
// 의미 없다(연결 대상이 아닌 내부 멤버) — 선택지에서 제외.
describe('NewConversationModal — 시스템 발행 제외(story #3997)', () => {
  it('⭐members에 「시스템 발행」이 섞여 와도 선택지엔 안 뜨고, 실 멤버는 그대로 뜬다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/members')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'm-yuna', name: '유나', type: 'human' },
              { id: 'sp1', name: '시스템 발행', type: 'agent', runtime_type: 'system-publisher' },
              { id: 'a-bot', name: '점검봇', type: 'agent', runtime_type: 'claude-code' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(wrap(<NewConversationModal projectId={PROJECT_ID} onClose={() => {}} onCreated={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).not.toContain('시스템 발행');
    expect(document.body.textContent).toContain('점검봇');
    expect(document.body.textContent).toContain('유나');
  });
});

describe('NewConversationModal — 이름 없는 사람 둘은 서로 다른 두 줄([SID:4286] · 유나 12:06Z)', () => {
  it('겹친 폴백 행에만 «· ID 앞 8자»', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.startsWith('/api/members')
        ? { ok: true, json: async () => ({ data: [
          { id: 'a2000000-1111', name: null, type: 'human' },
          { id: 'b3000000-2222', name: null, type: 'human' },
        ] }) }
        : { ok: true, json: async () => ({ data: [] }) }
    )));
    await act(async () => {
      root.render(wrap(<NewConversationModal projectId={PROJECT_ID} onClose={() => {}} onCreated={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const rows = Array.from(document.body.querySelectorAll('span.flex-1.truncate')).map((x) => x.textContent);
    expect(rows).toContain('이름 없는 구성원 · a2000000');
    expect(rows).toContain('이름 없는 구성원 · b3000000');
  });
});

describe('NewConversationModal — 에이전트 정책 거부 구조화 안내(story #2613)', () => {
  it('allowlist_miss — 대상 에이전트·멤버 이름과 워크포스 딥링크가 뜬다(AC2)', async () => {
    await mountAndSelect(mockFetches(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        data: null,
        error: {
          code: 'AGENT_MESSAGE_POLICY_DENIED',
          message: 'member is not in the agent allowlist',
          details: { agent_id: 'a-bot', member_id: 'm-yuna', reason: 'allowlist_miss' },
        },
        meta: null,
      }),
    })));

    expect(document.body.textContent).toContain('유나');
    expect(document.body.textContent).toContain('점검봇');
    // 서버의 영문 고정 메시지는 그대로 노출되지 않는다(계약 원칙).
    expect(document.body.textContent).not.toContain('member is not in the agent allowlist');
    const link = [...document.body.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/organization/workforce/a-bot');
    expect(link).toBeDefined();
    expect(link!.textContent).toBe(koMessages.chats.policyDeniedManageLink);
  });

  it('created_by_none — member_id 없어도 에이전트 이름과 딥링크가 뜬다', async () => {
    await mountAndSelect(mockFetches(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        data: null,
        error: {
          code: 'AGENT_MESSAGE_POLICY_DENIED',
          message: 'agent has no creator',
          details: { agent_id: 'a-bot', reason: 'created_by_none' },
        },
        meta: null,
      }),
    })));

    expect(document.body.textContent).toContain('점검봇');
    expect(document.body.textContent).toContain(koMessages.chats.policyDeniedCreatedByNone.replace('{agent}', '점검봇'));
    const link = [...document.body.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/organization/workforce/a-bot');
    expect(link).toBeDefined();
  });

  it('creator_not_participant — 에이전트 이름과 딥링크가 뜬다', async () => {
    await mountAndSelect(mockFetches(() => ({
      ok: false,
      status: 403,
      json: async () => ({
        data: null,
        error: {
          code: 'AGENT_MESSAGE_POLICY_DENIED',
          message: 'creator not a participant',
          details: { agent_id: 'a-bot', reason: 'creator_not_participant' },
        },
        meta: null,
      }),
    })));

    expect(document.body.textContent).toContain(koMessages.chats.policyDeniedCreatorNotParticipant.replace('{agent}', '점검봇'));
  });

  it('정책 거부가 아닌 4xx(generic)는 기존 문구 그대로(회귀 0) — 딥링크는 안 뜬다', async () => {
    await mountAndSelect(mockFetches(() => ({ ok: false, status: 422, json: async () => ({ data: null, error: { code: 'UNPROCESSABLE_ENTITY', message: 'unrelated validation error' }, meta: null }) })));

    expect(document.body.textContent).toContain('대화 생성에 실패했어요. 다시 시도해 주세요.');
    expect(document.body.querySelectorAll('a[href^="/organization/workforce/"]').length).toBe(0);
  });

  it('res.json()이 파싱 자체를 실패해도(빈 바디 등) generic 문구로 안전 폴백한다', async () => {
    await mountAndSelect(mockFetches(() => ({ ok: false, status: 500, json: async () => { throw new Error('no body'); } })));
    expect(document.body.textContent).toContain('대화 생성에 실패했어요. 다시 시도해 주세요.');
  });
});

// story #3049(2984-S1) — 후보 목록의 Bot 배지는 AgentIdentity(헤어라인+proof-blue 신호 dot),
// soft-fill 폐지(옛 PR-B의 proof-blue-soft 결정을 대체).
describe('NewConversationModal — story #3049(AgentIdentity 헤어라인+신호 dot)', () => {
  it('agent 후보 항목의 Bot 배지가 AgentIdentity를 쓰고 soft-fill/accent-claim은 안 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MEMBERS }) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(wrap(<NewConversationModal projectId={PROJECT_ID} onClose={() => {}} onCreated={() => {}} />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const badge = document.body.querySelector('.border-proof-line');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('에이전트');
    expect(badge?.className).not.toContain('bg-proof-blue-soft');
    expect(document.body.querySelector('.bg-accent-claim\\/15')).toBeNull();
  });
});

// story #4193 — 거부/실패 안내가 스크롤 목록 맨 끝이 아니라 목록 밖 고정 줄(목록과 푸터 사이)에 뜬다.
// 라이브(멤버 13명): 목록 안에 있을 땐 «대화 시작» 직후 보이는 영역 아래 380~414px에 묻혔다.
const MANY_MEMBERS = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `m-${i}`, name: `멤버${i + 1}`, type: 'human' })),
  { id: 'a-bot', name: '점검봇', type: 'agent' },
];
const POLICY_DENIED = {
  ok: false, status: 403,
  json: async () => ({
    data: null,
    error: { code: 'AGENT_MESSAGE_POLICY_DENIED', message: 'x', details: { agent_id: 'a-bot', member_id: 'm-0', reason: 'allowlist_miss' } },
    meta: null,
  }),
};

function assertAlertOutsideScroll(footerButtonText: string) {
  const alert = document.body.querySelector('[role="alert"]') as HTMLElement | null;
  expect(alert).not.toBeNull();
  // 스크롤 목록(max-h-[60vh] overflow-y-auto)의 자식이 아니다 — 목록 길이와 무관하게 클릭 직후 보인다.
  const scroll = document.body.querySelector('.overflow-y-auto') as HTMLElement;
  expect(scroll.contains(alert)).toBe(false);
  // 안내와 주 버튼이 같은 푸터 영역(선 하나) — 목록 바로 뒤가 그 영역이고, 안내 바로 다음이 버튼 줄이다(유나 design).
  const footer = alert!.parentElement!;
  expect(scroll.nextElementSibling).toBe(footer);
  expect([...alert!.nextElementSibling!.querySelectorAll('button')].some((b) => b.textContent === footerButtonText)).toBe(true);
  // 선은 푸터 영역 하나에만 — 안내·버튼 줄엔 따로 없다.
  expect(footer.className).toContain('border-t');
  expect(alert!.className).not.toContain('border-t');
  expect(alert!.nextElementSibling!.className).not.toContain('border-t');
  // 좁은 폭 줄바꿈: 본문은 낱말 단위, 링크는 한 덩어리.
  expect(alert!.className).toContain('break-keep');
  const link = alert!.querySelector('a');
  if (link) expect(link.className).toContain('whitespace-nowrap');
}

describe('NewConversationModal — 안내는 스크롤 목록 밖(story #4193)', () => {
  function manyFetch(post: () => unknown) {
    return vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.startsWith('/api/members')) return { ok: true, json: async () => ({ data: MANY_MEMBERS }) };
      if (url === '/api/conversations' && init?.method === 'POST') return post();
      return { ok: true, json: async () => ({}) };
    });
  }

  it('멤버 20명 — 정책 거부 안내가 목록 밖, 푸터 바로 위', async () => {
    await mountAndSelect(manyFetch(() => POLICY_DENIED));
    assertAlertOutsideScroll(koMessages.chats.create);
  });

  it('일반 실패 안내도 같은 자리', async () => {
    await mountAndSelect(manyFetch(() => ({ ok: false, status: 500, json: async () => ({ data: null, error: { code: 'HTTP_500', message: 'boom' }, meta: null }) })));
    assertAlertOutsideScroll(koMessages.chats.create);
  });
});
