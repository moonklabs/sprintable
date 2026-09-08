// @vitest-environment jsdom
//
// story 4f991165 — ⌘K 액션 확장 회귀가드. 기존 이동/문서검색/키보드 nav 무변경 + 신규 명령 그룹
// (route-first·context 랭킹·위험 pill·감시 금지)을 실 렌더로 검증(mock 컴포넌트 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { CommandPalette } from './command-palette';
import { NAV_GROUPS, CHAT_CENTER_ITEM } from '@/lib/nav-config';
import koMessagesRaw from '../../../messages/ko.json';

type LooseMessages = { [key: string]: string | LooseMessages };
const koMessages = koMessagesRaw as unknown as LooseMessages;

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function stubFetch(storyOverrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/stories/')) {
      return { ok: true, status: 200, json: async () => ({ data: { id: 's1', title: '웰컴 이메일 시안', ...storyOverrides } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', stubFetch());
  pushMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <CommandPalette open onOpenChange={vi.fn()} {...props} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('CommandPalette — existing navigate/search behavior (regression guard)', () => {
  it('renders navigate destinations with correct 으로/로 조사(회귀 — story #3698 실측으로 잡힌 "알림로" 오생성)', async () => {
    await mount();
    expect(document.body.textContent).toContain('알림으로 이동'); // 림=ㅁ받침
    expect(document.body.textContent).toContain('보드로 이동'); // 드=받침없음
    expect(document.body.textContent).toContain('문서로 이동'); // 서=받침없음
  });

  it('shows no context chip when there is no contextStoryId', async () => {
    await mount();
    expect(document.body.textContent).not.toContain('◆');
  });
});

// story #3698(IA·후속, PO 確定 2026-09-08) — navigate 목적지=NAV_GROUPS(24)+CHAT_CENTER_
// ITEM(1) 파생. AC3는 "수 고정"이 아니라 "집합 대조"로 잠근다(페드루 PO 정련 — nav가 늘면
// 파생도 같이 늘어 고정 수 테스트는 오탐 RED가 된다. 집합 대조라야 "어떤 nav 목적지도
// 팔레트서 안 빠진다"를 nav 성장과 무관하게 지킨다). go-sprints·go-epics 2개는 NAV_GROUPS
// 밖의 문서화된 예외(#2376 orphan-route 가드 앵커)라 집합에서 뺀 뒤 대조한다.
describe('CommandPalette — navigate 목적지 = NAV_GROUPS 파생(story #3698 AC1·AC3)', () => {
  const GUARD_ANCHOR_IDS = new Set(['go-sprints', 'go-epics']);

  it('팔레트 navigate id 집합이 정확히 NAV_GROUPS 전 항목 + CHAT_CENTER_ITEM과 같다(앵커 2개는 문서화된 예외로 제외)', async () => {
    await mount();
    const renderedIds = new Set(
      [...document.querySelectorAll('[data-command-group="navigate"] [data-command-id]')]
        .map((el) => el.getAttribute('data-command-id')!),
    );
    const renderedNavIds = new Set([...renderedIds].filter((id) => !GUARD_ANCHOR_IDS.has(id)));
    const expectedNavIds = new Set([
      ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)),
      CHAT_CENTER_ITEM.id,
    ]);
    // 집합 대조(수 고정 아님) — nav가 늘어도 이 두 집합은 같은 소스(NAV_GROUPS)에서
    // 나오므로 항상 같이 늘어난다. 파생이 깨져(예: 하드코딩으로 되돌아가) 어떤 nav
    // 항목이 팔레트서 빠지면 이 대조가 그 즉시 RED가 된다.
    expect(renderedNavIds).toEqual(expectedNavIds);
    // 앵커 2개는 여전히 렌더되지만(아래 별도 테스트) 이 집합 밖(문서화된 예외).
    expect([...GUARD_ANCHOR_IDS].every((id) => renderedIds.has(id))).toBe(true);
  });

  it('org-workforce(에이전트)·docs(문서)·board(보드) 등 서로 다른 구역의 항목이 전부 실제로 렌더된다(하드코딩 7개 시절엔 누락됐던 항목들)', async () => {
    await mount();
    // S1 이전엔 팔레트가 24 중 5(inbox·board·chats·org-workforce·docs)만 도달했다 — 이번
    // 파생으로 그 밖의 항목(신뢰·지식·마케팅·조직 구역)도 전부 도달하는지 표본 확認.
    expect(document.body.textContent).toContain('신뢰 센터'); // org-trust(신뢰 구역, 예전엔 누락)
    expect(document.body.textContent).toContain('블로그 포스트'); // content(마케팅 구역, 예전엔 누락)
    expect(document.body.textContent).toContain('기억'); // org-memory(지식 구역, 예전엔 누락)
    expect(document.body.textContent).toContain('설정'); // settings(예전엔 누락)
  });

  it('기존 단축키(G I/B/M/A/S)가 파생 항목에도 그대로 보존된다', async () => {
    await mount();
    const shortcutTexts = [...document.querySelectorAll('kbd')].map((el) => el.textContent);
    expect(shortcutTexts).toContain('G');
    expect(shortcutTexts).toContain('I');
    expect(shortcutTexts).toContain('B');
    expect(shortcutTexts).toContain('M');
    expect(shortcutTexts).toContain('A');
    expect(shortcutTexts).toContain('S');
  });

  it('go-sprints·go-epics 가드 앵커는 그대로 남아 있다(#2376 orphan-route 가드용, 지우면 안 됨)', async () => {
    await mount();
    expect(document.body.textContent).toContain('스프린트로 이동');
    expect(document.body.textContent).toContain('에픽으로 이동');
  });

  it('board 목적지는 /flow?view=list로 라우팅한다(리다이렉트 경유 금지, story #2224)', async () => {
    await mount();
    const boardBtn = document.querySelector('[data-command-id="board"]') as HTMLButtonElement;
    expect(boardBtn).toBeDefined();
    await act(async () => { boardBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/flow?view=list');
  });
});

describe('CommandPalette — action commands (story 4f991165)', () => {
  it('without story context, only the 2 project-scoped commands render (delegate omitted — no valid target)', async () => {
    await mount();
    expect(document.body.textContent).toContain('게이트 결재하기');
    expect(document.body.textContent).toContain('에이전트 모집하기');
    expect(document.body.textContent).not.toContain('위임하기');
  });

  it('with a contextStoryId, fetches the story title and shows the context chip + delegate command', async () => {
    await mount({ contextStoryId: 's1' });
    expect(document.body.textContent).toContain('웰컴 이메일 시안 · 스토리');
    expect(document.body.textContent).toContain('웰컴 이메일 시안 위임하기');
  });

  it('story 9ac9b80f — context chip prefixes the human-readable #N when story_number is present', async () => {
    vi.stubGlobal('fetch', stubFetch({ story_number: 42 }));
    await mount({ contextStoryId: 's1' });
    const chip = document.querySelector('.border-b.border-border\\/60.bg-muted\\/30');
    expect(chip).toBeDefined();
    expect(chip!.textContent).toBe('◆#42 웰컴 이메일 시안 · 스토리');
  });

  it('story 9ac9b80f — omits the #N prefix when story_number is null (pre-backfill story, no-fiction)', async () => {
    vi.stubGlobal('fetch', stubFetch({ story_number: null }));
    await mount({ contextStoryId: 's1' });
    // 까심 QA(#2227 RC): '#null' 문자열만 부재 확認으론 '#undefined'류 인접 버그를 못 잡는다 —
    // 칩 엘리먼트 자체의 정확한 텍스트를 assert해 어떤 형태의 조작된 '#...' 접두도 차단.
    const chip = document.querySelector('.border-b.border-border\\/60.bg-muted\\/30');
    expect(chip).toBeDefined();
    expect(chip!.textContent).toBe('◆웰컴 이메일 시안 · 스토리');
    expect(chip!.textContent).not.toMatch(/#/);
  });

  it('flags the gate-decision command as a sensitive/danger pill (amber, not red — learning-signal)', async () => {
    await mount();
    expect(document.body.textContent).toContain('위험 명령 · 확인 단계 경유');
  });

  it('selecting an action command routes (route-first) instead of performing an inline mutation', async () => {
    await mount();
    const recruitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('에이전트 모집하기'));
    expect(recruitBtn).toBeDefined();
    await act(async () => { recruitBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/organization/workforce/recruiter');
  });

  it('does not render any command execution history/count/recency (surveillance-reframe guard)', async () => {
    await mount({ contextStoryId: 's1' });
    expect(document.body.textContent).not.toMatch(/\d+\s*(회|번|분 전|초 전)/);
  });
});

// story #3007(로드맵 P2·PR-E, L1) — cmd palette 다이얼로그는 floating이라 --elev-overlay.
describe('CommandPalette — 로드맵 P2·PR-E L1(다이얼로그 elevation 토큰)', () => {
  it('팝업이 shadow-[var(--elev-overlay)]를 쓰고 shadow-lg는 안 쓴다', async () => {
    await mount();
    const popup = document.body.querySelector('.rounded-xl.bg-popover');
    expect(popup?.className).toContain('shadow-[var(--elev-overlay)]');
    expect(popup?.className).not.toMatch(/(^|\s)shadow-lg(\s|$)/);
  });
});
