// @vitest-environment jsdom
//
// story #2267(C-9) AC4/AC7 — 「무엇에서 만들었나」(출처) 섹션. EntityBacklinksSection의
// still_exists 처리(사실로만 보인다·비난 없는 문구)를 그대로 재사용하는지, AC7 계약(못 찾으면
// 항상 같은 미수집 문구, 분기 없음)이 지켜지는지를 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StoryOriginSection } from './story-origin-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(storyId: string) {
  await act(async () => {
    root.render(withIntl(<StoryOriginSection storyId={storyId} />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('StoryOriginSection', () => {
  it('relation==="created_from" 항목이 있으면 출처 카드를 그린다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', relation: 'created_from', still_exists: true, doc: { id: 'd1', title: '설계 문서' }, message: null, meeting: null, story: null }],
    }))));
    await render('s1');
    expect(container.textContent).toContain('설계 문서');
    expect(container.textContent).not.toContain('출처 미수집');
  });

  it('AC7 — created_from 항목이 없으면(빈 배열) 항상 같은 미수집 문구를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }))));
    await render('s1');
    expect(container.textContent).toContain('출처 미수집');
    expect(container.textContent).toContain('«없음»이 아니라 «모름»');
  });

  it('AC7 — relation="none"(그냥 멘션) 항목만 있어도 「출처 없음」이 아니라 같은 미수집 문구다(분기하지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', relation: 'none', still_exists: true, doc: { id: 'd1', title: '그냥 멘션' }, message: null, meeting: null, story: null }],
    }))));
    await render('s1');
    expect(container.textContent).toContain('출처 미수집');
    expect(container.textContent).not.toContain('그냥 멘션');
  });

  it('출처 대상이 사라졌어도(still_exists=false) 「대상이 없습니다」로 사실만 보인다(비난 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'r1', source_type: 'meeting', source_id: 'm1', created_by: null, created_at: '2026-07-28T00:00:00Z', relation: 'created_from', still_exists: false, doc: null, message: null, meeting: { id: 'm1', title: '킥오프 회의' }, story: null }],
    }))));
    await render('s1');
    expect(container.textContent).toContain('킥오프 회의');
    expect(container.textContent).toContain('대상이 없습니다');
    expect(container.innerHTML).not.toContain('text-destructive');
  });

  it('chat_message 출처는 /chats/{conversation_id}?messageId= 딥링크로 이어진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'r1', source_type: 'chat_message', source_id: 'msg1', created_by: null, created_at: '2026-07-28T00:00:00Z', relation: 'created_from', still_exists: true, doc: null, message: { id: 'msg1', conversation_id: 'conv1', content_snippet: '이 아이디어에서 시작', sender: null }, meeting: null, story: null }],
    }))));
    await render('s1');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/chats/conv1?messageId=msg1');
  });

  it('PO 지적(2026-07-30) — created_from이 둘째 페이지에 있어도 찾아낸다(첫 페이지엔 멘션만 30+건)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes('before=')) {
        // 1페이지 — 멘션뿐, has_more=true.
        return new Response(JSON.stringify({
          data: [{ id: 'm1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-29T00:00:00Z', relation: 'none', still_exists: true, doc: { id: 'd1', title: '최근 멘션' }, message: null, meeting: null, story: null }],
          meta: { next_cursor: 'cursor-2', has_more: true },
        }));
      }
      // 2페이지(before=cursor-2) — 진짜 출처가 여기.
      return new Response(JSON.stringify({
        data: [{ id: 'origin1', source_type: 'doc', source_id: 'd2', created_by: null, created_at: '2026-07-01T00:00:00Z', relation: 'created_from', still_exists: true, doc: { id: 'd2', title: '원본 설계 문서' }, message: null, meeting: null, story: null }],
        meta: { next_cursor: null, has_more: false },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await render('s1');
    expect(container.textContent).toContain('원본 설계 문서');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toContain('before=cursor-2');
  });

  it('첫 페이지에서 찾으면 둘째 페이지를 더 안 부른다(호출 낭비 없음)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'origin1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-30T00:00:00Z', relation: 'created_from', still_exists: true, doc: { id: 'd1', title: '즉시 발견' }, message: null, meeting: null, story: null }],
      meta: { next_cursor: 'cursor-2', has_more: true },
    })));
    vi.stubGlobal('fetch', fetchMock);
    await render('s1');
    expect(container.textContent).toContain('즉시 발견');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('전 페이지를 다 봐도(has_more 소진) 못 찾으면 미수집 문구로 정직하게 닫는다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes('before=')) {
        return new Response(JSON.stringify({
          data: [{ id: 'm1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-29T00:00:00Z', relation: 'none', still_exists: true, doc: { id: 'd1', title: '멘션1' }, message: null, meeting: null, story: null }],
          meta: { next_cursor: 'cursor-2', has_more: true },
        }));
      }
      return new Response(JSON.stringify({
        data: [{ id: 'm2', source_type: 'doc', source_id: 'd2', created_by: null, created_at: '2026-07-01T00:00:00Z', relation: 'none', still_exists: true, doc: { id: 'd2', title: '멘션2' }, message: null, meeting: null, story: null }],
        meta: { next_cursor: null, has_more: false },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await render('s1');
    expect(container.textContent).toContain('출처 미수집');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('PO 지적(2026-07-30) — MAX_PAGES 상한까지 다 봤는데 못 찾으면 개발자에게만 경고(화면은 그대로 미수집)', async () => {
    // has_more:true를 계속 주는 무한 페이지처럼 흉내(진짜라면 있을 수 없는 비정상 상황).
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'm', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-01T00:00:00Z', relation: 'none', still_exists: true, doc: { id: 'd1', title: '멘션' }, message: null, meeting: null, story: null }],
      meta: { next_cursor: 'cursor-next', has_more: true },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render('s1');
    expect(container.textContent).toContain('출처 미수집'); // 화면은 그대로 정직한 미수집
    expect(fetchMock).toHaveBeenCalledTimes(10); // MAX_PAGES=10에서 멈춘다(무한루프 아님)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('MAX_PAGES');
  });

  it('정상적으로 전 페이지를 다 봐서(has_more 소진) 못 찾은 경우엔 경고를 안 낸다(비정상 신호와 구분)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'm', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-01T00:00:00Z', relation: 'none', still_exists: true, doc: { id: 'd1', title: '멘션' }, message: null, meeting: null, story: null }],
      meta: { next_cursor: null, has_more: false },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render('s1');
    expect(container.textContent).toContain('출처 미수집');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('fetch 실패 시 조용히 아무것도 안 그린다(EntityBacklinksSection과 동형)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await render('s1');
    expect(container.textContent).toBe('');
  });
});
