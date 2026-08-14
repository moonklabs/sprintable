// @vitest-environment jsdom
//
// story #2621 v1 — DeliveryContractModal 회귀가드. 핵심 위험 = GET /api/notification-preferences가
// [[feedback-cross-layer-contract-real-payload]] 클래스의 이중 envelope로 온다: BE가 이미
// {data:[...]}를 돌려주는데(notification_preferences.py) FE 프록시가 apiSuccess()로 한 번 더
// 감싸(api-response.ts) 최종 {data:{data:[...]},error:null,meta:null}이 된다 — 이 테스트는
// 그 정확한 이중 wrap 모양으로 mock해 파싱이 안 깨지는지 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DeliveryContractModal } from './delivery-contract-modal';
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

const CONV_ID = 'conv-1';

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

describe('DeliveryContractModal — story #2621 v1', () => {
  it('오버라이드가 없으면(빈 목록) 기본값 표시로 폴백한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) })));
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}}
        />,
      ));
    });
    await act(async () => {});
    expect(document.body.textContent).toContain('설정한 값이 없어 기본값을 따릅니다');
    const allBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '전체')!;
    expect(allBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('이중 envelope({data:{data:[...]}})에서 이 대화·sse 채널의 기존 레벨을 정확히 읽는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          data: [
            { scope_type: 'conversation', scope_id: CONV_ID, channel: 'sse', level: 'mentions' },
            // 다른 스코프/채널은 섞여 있어도 안 골라져야 한다(대조군).
            { scope_type: 'conversation', scope_id: 'other-conv', channel: 'sse', level: 'mute' },
            { scope_type: 'global', scope_id: null, channel: 'sse', level: 'all' },
          ],
        },
        error: null,
        meta: null,
      }),
    })));
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}}
        />,
      ));
    });
    await act(async () => {});
    expect(document.body.textContent).toContain('이 대화에 별도로 설정한 값입니다');
    const mentionsBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '멘션만')!;
    expect(mentionsBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('레벨 버튼 클릭 시 PUT이 정확한 payload(scope_type=conversation·scope_id·channel=sse)로 나간다', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') return { ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) };
      return { ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}}
        />,
      ));
    });
    await act(async () => {});
    const muteBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '끄기')!;
    await act(async () => { muteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const putCall = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT')!;
    expect(JSON.parse((putCall[1] as { body: string }).body)).toEqual({
      preferences: [{ scope_type: 'conversation', scope_id: CONV_ID, channel: 'sse', level: 'mute' }],
    });
  });

  it('dm 대화에서는 free_response 토글 자체가 안 보인다(항상 default=all이라 의미 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) })));
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="dm" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}}
        />,
      ));
    });
    await act(async () => {});
    expect(document.body.textContent).not.toContain('멘션 없이도 자유롭게 응답');
  });

  it('free_response 토글 시 PATCH /api/conversations/{id}가 호출되고 onFreeResponseChange가 다음 값으로 불린다', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const onFreeResponseChange = vi.fn();
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={onFreeResponseChange}
        />,
      ));
    });
    await act(async () => {});
    const toggle = document.body.querySelector('[data-slot="switch"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const patchCall = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH')!;
    expect(patchCall[0]).toBe(`/api/conversations/${CONV_ID}`);
    expect(JSON.parse((patchCall[1] as { body: string }).body)).toEqual({ free_response: true });
    expect(onFreeResponseChange).toHaveBeenCalledWith(true);
  });
});

describe('DeliveryContractModal — story #2623 pre-work(targetMemberId 대리 편집 배선)', () => {
  const AGENT_ID = 'agent-9';

  it('targetMemberId가 있으면 GET에 ?member_id=가 실린다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}} targetMemberId={AGENT_ID}
        />,
      ));
    });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith(`/api/notification-preferences?member_id=${AGENT_ID}`);
  });

  it('targetMemberId가 없으면 GET이 기존과 동일한(쿼리 없는) 경로 그대로다(회귀 없음)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}}
        />,
      ));
    });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith('/api/notification-preferences');
  });

  it('targetMemberId가 있으면 PUT body에 member_id가 실린다(scope_type/scope_id/channel/level은 그대로)', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}} targetMemberId={AGENT_ID}
        />,
      ));
    });
    await act(async () => {});
    const muteBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '끄기')!;
    await act(async () => { muteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const putCall = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT')!;
    expect(JSON.parse((putCall[1] as { body: string }).body)).toEqual({
      preferences: [{ scope_type: 'conversation', scope_id: CONV_ID, channel: 'sse', level: 'mute' }],
      member_id: AGENT_ID,
    });
  });

  it('targetMemberId가 있으면 헤더에 "대신 편집하는 중" 안내가 뜬다(본인 계약 착각 방지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) })));
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}}
          targetMemberId={AGENT_ID} targetMemberLabel="레이서 에이전트"
        />,
      ));
    });
    await act(async () => {});
    expect(document.body.textContent).toContain('"레이서 에이전트"님을 대신해 편집 중');
    expect(document.body.textContent).toContain('저장 시 그 멤버의 수신 설정이 바뀝니다');
  });

  it('targetMemberId가 있으면 group 대화여도 free_response 토글이 안 보인다(대리 편집 스코프 밖 — 대화 전역 축)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { data: [] }, error: null, meta: null }) })));
    await act(async () => {
      root.render(wrap(
        <DeliveryContractModal
          conversationId={CONV_ID} conversationType="group" freeResponse={false}
          onClose={() => {}} onFreeResponseChange={() => {}} targetMemberId={AGENT_ID}
        />,
      ));
    });
    await act(async () => {});
    expect(document.body.textContent).not.toContain('멘션 없이도 자유롭게 응답');
  });
});
