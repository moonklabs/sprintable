// @vitest-environment jsdom
//
// story #2623 — 「멤버 관점 요약」 읽기 표면(AC3). 신규 API 없음 — 기존
// GET /api/notification-preferences?member_id=(933248fa 동형 admin override, BE 착지 대기)
// 재사용. BE 착지 前에도 이 컴포넌트 자체는 이중 envelope 파싱·필터링·에러/빈 상태 분기를
// 정확히 하는지 지금 고정해 둔다(BE 착지 시 그대로 통합 검증만 남게).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { MemberNotificationPreferencesSummary } from './member-notification-preferences-summary';
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

describe('MemberNotificationPreferencesSummary — story #2623', () => {
  it('GET에 member_id 쿼리가 실린다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<MemberNotificationPreferencesSummary memberId="agent-1" memberLabel="Agent One" />)); });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith('/api/notification-preferences?member_id=agent-1');
  });

  it('conversation·sse 항목만 골라 대화id×레벨로 보여준다(다른 scope_type/channel은 걸러짐)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          data: [
            { scope_type: 'conversation', scope_id: 'conv-1', channel: 'sse', level: 'mentions' },
            { scope_type: 'conversation', scope_id: 'conv-2', channel: 'sse', level: 'mute' },
            { scope_type: 'global', scope_id: null, channel: 'sse', level: 'all' },
            { scope_type: 'conversation', scope_id: 'conv-3', channel: 'discord', level: 'all' },
          ],
        },
        error: null,
        meta: null,
      }),
    })));
    await act(async () => { root.render(wrap(<MemberNotificationPreferencesSummary memberId="agent-1" memberLabel="Agent One" />)); });
    await act(async () => {});
    expect(document.body.textContent).toContain('conv-1');
    expect(document.body.textContent).toContain('멘션만');
    expect(document.body.textContent).toContain('conv-2');
    expect(document.body.textContent).toContain('끄기');
    // global·discord 채널은 이 요약(conversation×sse)에 안 섞인다.
    expect(document.body.textContent).not.toContain('conv-3');
    expect(document.body.querySelectorAll('li').length).toBe(2);
  });

  it('빈 목록이면 "설정 없음(기본값)"으로 정직하게 갈린다(지어내지 않음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) })));
    await act(async () => { root.render(wrap(<MemberNotificationPreferencesSummary memberId="agent-1" memberLabel="Agent One" />)); });
    await act(async () => {});
    expect(document.body.textContent).toContain('설정된 대화별 수신 레벨이 없습니다');
  });

  it('fetch 실패(예: BE 착지 前 무권한 403)는 에러 상태로 갈린다 — 빈 목록으로 오인하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    await act(async () => { root.render(wrap(<MemberNotificationPreferencesSummary memberId="agent-1" memberLabel="Agent One" />)); });
    await act(async () => {});
    expect(document.body.textContent).toContain('수신 계약을 불러오지 못했습니다');
    expect(document.body.textContent).not.toContain('설정된 대화별 수신 레벨이 없습니다');
  });

  it('유나 확定 ④ — GET /api/conversations/{id}로 대화 제목을 해소해 raw id 대신 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/notification-preferences')) {
        return {
          ok: true,
          json: async () => ({
            data: { data: [{ scope_type: 'conversation', scope_id: 'conv-1', channel: 'sse', level: 'mentions' }] },
            error: null, meta: null,
          }),
        };
      }
      if (url === '/api/conversations/conv-1') {
        return { ok: true, json: async () => ({ title: '릴리스 준비', type: 'group' }) };
      }
      throw new Error(`unmocked: ${url}`);
    }));
    await act(async () => { root.render(wrap(<MemberNotificationPreferencesSummary memberId="agent-1" memberLabel="Agent One" />)); });
    await act(async () => {});
    await act(async () => {});
    expect(document.body.textContent).toContain('릴리스 준비');
    expect(document.body.textContent).not.toContain('conv-1');
  });

  it('제목 해소 실패(대화 사라짐 등)는 short id 폴백으로 정직하게 떨어진다(지어내지 않음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/notification-preferences')) {
        return {
          ok: true,
          json: async () => ({
            data: { data: [{ scope_type: 'conversation', scope_id: '11111111-aaaa-bbbb-cccc-222222222222', channel: 'sse', level: 'all' }] },
            error: null, meta: null,
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    }));
    await act(async () => { root.render(wrap(<MemberNotificationPreferencesSummary memberId="agent-1" memberLabel="Agent One" />)); });
    await act(async () => {});
    await act(async () => {});
    expect(document.body.textContent).toContain('#11111111');
  });

  it('유나 확定 ①②③ — 행의 「편집」 아이콘이 (targetMemberId=memberId·conversationId=그 행) 값으로 DeliveryContractModal을 연다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/notification-preferences')) {
        if (url.includes('member_id=agent-1')) {
          return {
            ok: true,
            json: async () => ({
              data: { data: [{ scope_type: 'conversation', scope_id: 'conv-9', channel: 'sse', level: 'mentions' }] },
              error: null, meta: null,
            }),
          };
        }
        // DeliveryContractModal이 열리면서 다시 부르는 GET(?member_id=agent-1 포함, 위에서 이미 처리) —
        // 여기 안 걸리면 최소 빈 목록으로 안전 폴백.
        return { ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) };
      }
      if (url === '/api/conversations/conv-9') return { ok: true, json: async () => ({ title: '데일리 스탠드업', type: 'group' }) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => { root.render(wrap(<MemberNotificationPreferencesSummary memberId="agent-1" memberLabel="레이서 에이전트" />)); });
    await act(async () => {});
    await act(async () => {});

    const editBtn = document.body.querySelector('button[aria-label="편집"]') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    await act(async () => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {});

    // 모달이 열렸다 — 대리 편집 배너가 정확한 대상 라벨로 뜬다(별도 조회 없이 행이 이미 아는 값).
    expect(document.body.textContent).toContain('"레이서 에이전트"님을 대신해 편집 중');
    // free_response는 대리 편집 스코프 밖(유나 확定과 별개 회귀가드, #2621 conversationType=group이어도 안 뜸).
    expect(document.body.textContent).not.toContain('멘션 없이도 자유롭게 응답');
  });
});
