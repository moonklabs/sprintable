// @vitest-environment jsdom
//
// story 4f991165 — ⌘K 액션 확장 회귀가드. 기존 이동/문서검색/키보드 nav 무변경 + 신규 명령 그룹
// (route-first·context 랭킹·위험 pill·감시 금지)을 실 렌더로 검증(mock 컴포넌트 0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { CommandPalette } from './command-palette';
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
  it('still renders all 7 navigate destinations with no context (existing behavior untouched)', async () => {
    await mount();
    expect(document.body.textContent).toContain('인박스로 이동');
    expect(document.body.textContent).toContain('보드로 이동');
    expect(document.body.textContent).toContain('문서로 이동');
  });

  it('shows no context chip when there is no contextStoryId', async () => {
    await mount();
    expect(document.body.textContent).not.toContain('◆');
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
