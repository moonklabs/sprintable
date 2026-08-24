// @vitest-environment jsdom
//
// story #2638 — IntentSuggestionCard 실 마운트(클릭→fetch 실호출·닫기→카드 소멸)까지
// 확認한다. computeSuggestion 자체는 순수함수 테스트(intent-suggestion-card.compute.test.ts)로
// 이미 덮였으므로 여긴 렌더+상호작용만 본다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntentSuggestionCard } from './intent-suggestion-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: Map<string, string>;
function stubLocalStorage() {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string) => `${ns}.${key}`;
    t.rich = (key: string) => `${ns}.${key}`;
    t.markup = (key: string) => `${ns}.${key}`;
    t.raw = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
  useLocale: () => 'ko',
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ currentTeamMemberId: 'member-1' }),
}));

const DOC_ID = 'aabbccdd-1111-1111-1111-111111111111';
// PO 라이브 판정 RED(2026-08-15) 회귀가드 — 실 정본 이스케이프 토큰 형태로.
const docToken = `[\\[QA·폐기용\\] 제목](entity:doc:${DOC_ID})`;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}

describe('IntentSuggestionCard — mount', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stubLocalStorage();
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('AC1/AC2(story #3004로 갱신) — 승인 의도 감지 시 카드가 뜨고, CTA는 문서 페이지로 route-first 딥링크한다(직접 제출 없음)', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <IntentSuggestionCard
          messageId="msg-1"
          content={`${docToken} 승인 주시면 감사하겠습니다`}
          isMine
          entityStatusByKey={{ [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } }}
        />,
      );
    });

    expect(container.textContent).toContain('chats.intentSuggestionApprovalCta');
    // story #3004(선생님 정책 확定 2026-08-24) — approver_member_id가 서버 필수가 되며 이
    // 슬림 카드는 더 이상 직접 제출하지 않는다(픽커를 놓을 공간이 없다 — Pedro 리뷰 PR
    // #3435). 문서 페이지(doc-gate-section.tsx, 픽커 실물 보유)로 route-first 딥링크.
    const goToDocLink = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'chats.intentSuggestionGoToDoc');
    expect(goToDocLink).toBeTruthy();
    expect(goToDocLink!.getAttribute('href')).toBe(`/docs?id=${DOC_ID}`);
    // "예"(handleConfirm 버튼)가 이 kind엔 더 이상 렌더되지 않는다 — 순수 링크뿐이라 클릭이
    // fetch를 쏠 방법 자체가 없다(next/link의 jsdom 클릭 시뮬레이션은 라우터 부재로 불안정해
    // 별도로 시도하지 않는다 — 구조적 부재로 충분히 증명됨).
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).not.toContain('chats.intentSuggestionConfirm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('음성대조 — 남의 메시지(isMine=false)엔 조건이 다 맞아도 카드가 안 뜬다', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <IntentSuggestionCard
          messageId="msg-2"
          content={`${docToken} 승인 주시면 감사하겠습니다`}
          isMine={false}
          entityStatusByKey={{ [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } }}
        />,
      );
    });
    expect(container.textContent).not.toContain('chats.intentSuggestionApprovalCta');
  });

  it('닫기 클릭 시 카드가 사라지고, 재마운트해도 다시 안 뜬다(localStorage 거절 기억)', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <IntentSuggestionCard
          messageId="msg-3"
          content={`${docToken} 승인 주시면 감사하겠습니다`}
          isMine
          entityStatusByKey={{ [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } }}
        />,
      );
    });
    const dismissBtn = container.querySelector('button[aria-label="chats.intentSuggestionDismiss"]') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();
    await act(async () => { dismissBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).not.toContain('chats.intentSuggestionApprovalCta');

    // 재마운트(예: 스크롤 밖-안 재진입) — localStorage가 거절을 기억해 다시 안 뜬다.
    await act(async () => { root.unmount(); });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <IntentSuggestionCard
          messageId="msg-3"
          content={`${docToken} 승인 주시면 감사하겠습니다`}
          isMine
          entityStatusByKey={{ [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } }}
        />,
      );
    });
    expect(container.textContent).not.toContain('chats.intentSuggestionApprovalCta');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
