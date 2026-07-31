// @vitest-environment jsdom
//
// story #2299(E-CONNECT) — 「이것을 가리키는 것들」 목록의 still_exists 표시 규율(유나 확定):
// ①끊어진 항목도 목록에서 안 뺀다 ②사실로 보인다(오류색 없음) ③비난 없는 문구
// ④종류(doc/chat_message)와 무관하게 문구 한 벌.
//
// 두 번째 자리(doc [slug]/view)가 오면서 StoryBacklinksSection→EntityBacklinksSection으로
// 일반화됐다(entityType/entityId 축) — 기존 story 케이스는 entityType="story"로 그대로,
// doc 전용 케이스(URL 파생·재사용 확인)를 추가한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EntityBacklinksSection } from './entity-backlinks-section';

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

async function render(entityType: 'story' | 'doc', entityId: string) {
  await act(async () => {
    root.render(withIntl(<EntityBacklinksSection entityType={entityType} entityId={entityId} />));
  });
  // useEffect의 fetch가 resolve될 시간을 준다.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('EntityBacklinksSection', () => {
  it('①끊어진 항목(still_exists=false)도 목록에서 안 빠진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: false, doc: { id: 'd1', title: '삭제된 문서' }, message: null },
        { id: 'r2', source_type: 'doc', source_id: 'd2', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: true, doc: { id: 'd2', title: '살아있는 문서' }, message: null },
      ],
      meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
    }))));
    await render('story', 's1');
    expect(container.textContent).toContain('삭제된 문서');
    expect(container.textContent).toContain('살아있는 문서');
  });

  it('②사실로만 보인다 — 경고 문구("삭제됨"·"깨짐") 없이 ③비난없는 「대상이 없습니다」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: false, doc: { id: 'd1', title: '문서' }, message: null }],
      meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
    }))));
    await render('story', 's1');
    expect(container.textContent).toContain('대상이 없습니다');
    expect(container.textContent).not.toContain('삭제됨');
    expect(container.textContent).not.toContain('깨짐');
    expect(container.textContent).not.toContain('미기록');
  });

  it('②오류색/경고색이 아니라 회색이다 — text-destructive·text-warning·border-warning 클래스 미사용', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: false, doc: { id: 'd1', title: '문서' }, message: null }],
      meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
    }))));
    await render('story', 's1');
    expect(container.innerHTML).not.toContain('text-destructive');
    expect(container.innerHTML).not.toContain('text-warning');
    expect(container.innerHTML).not.toContain('border-warning');
    expect(container.innerHTML).not.toContain('bg-warning');
  });

  it('④종류가 doc이든 chat_message든 끊어짐 문구는 한 벌이다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: false, doc: { id: 'd1', title: '문서 하나' }, message: null },
        { id: 'r2', source_type: 'chat_message', source_id: 'm1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: false, doc: null, message: { id: 'm1', conversation_id: 'c1', content_snippet: '메시지 하나', sender: null } },
      ],
      meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
    }))));
    await render('story', 's1');
    const matches = container.textContent?.match(/대상이 없습니다/g) ?? [];
    expect(matches.length).toBe(2); // 두 항목 모두 같은 문구 한 벌
  });

  it('빈 목록이면 수집범위를 실은 0건 문구를 보인다(미수집을 없음으로 표시하지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [],
      meta: {
        next_cursor: null, has_more: false,
        collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: ['pr_sid_text_convention', 'evidence_free_text_reference'] },
      },
    }))));
    await render('story', 's1');
    expect(container.textContent).toContain('관찰된 참조 0건');
    expect(container.textContent).toContain('chat_message');
    expect(container.textContent).toContain('PR/커밋');
    expect(container.textContent).toContain('증거');
  });

  it('빈 목록에 살아있는 항목만 있으면 「대상이 없습니다」가 안 뜬다(정상 케이스 오탐 방지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: true, doc: { id: 'd1', title: '살아있는 문서' }, message: null }],
      meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
    }))));
    await render('story', 's1');
    expect(container.textContent).toContain('살아있는 문서');
    expect(container.textContent).not.toContain('대상이 없습니다');
  });

  it('fetch 실패 시 조용히 아무것도 안 그린다(노이즈 0, 다른 애드온 섹션과 동형)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await render('story', 's1');
    expect(container.textContent).toBe('');
  });

  it('story-detail-panel은 story 전환 시 이 컴포넌트를 리마운트 안 한다 — entityId prop만 바뀌어도 이전 결과가 안 새어 보인다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/stories/s1/')) {
        return new Response(JSON.stringify({
          data: [{ id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: true, doc: { id: 'd1', title: 'S1 전용 문서' }, message: null }],
          meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
        }));
      }
      // s2 요청은 응답을 영원히 안 준다(pending) — s1 결과가 새어 나오면 이 테스트가 잡는다.
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    await render('story', 's1');
    expect(container.textContent).toContain('S1 전용 문서');

    // 같은 인스턴스에 entityId prop만 바뀐다(리마운트 없음) — kanban-board.tsx의 실제 렌더 패턴.
    await act(async () => {
      root.render(withIntl(<EntityBacklinksSection entityType="story" entityId="s2" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).not.toContain('S1 전용 문서'); // 전환 중엔 이전 결과가 안 보인다
  });

  it('story #2267(C-9) AC4 — relation==="created_from" 항목은 이 목록에서 빠진다(출처는 별도 섹션 몫)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', relation: 'created_from', still_exists: true, doc: { id: 'd1', title: '출처 문서' }, message: null, meeting: null, story: null },
        { id: 'r2', source_type: 'doc', source_id: 'd2', created_by: null, created_at: '2026-07-28T00:00:00Z', relation: 'none', still_exists: true, doc: { id: 'd2', title: '그냥 멘션 문서' }, message: null, meeting: null, story: null },
      ],
      meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
    }))));
    await render('story', 's1');
    expect(container.textContent).not.toContain('출처 문서');
    expect(container.textContent).toContain('그냥 멘션 문서');
  });

  it('story #2267(C-9) — relation==="created_from" 항목만 있으면(멘션 0건) 수집범위 0건 문구를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'r1', source_type: 'doc', source_id: 'd1', created_by: null, created_at: '2026-07-28T00:00:00Z', relation: 'created_from', still_exists: true, doc: { id: 'd1', title: '출처 문서' }, message: null, meeting: null, story: null },
      ],
      meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
    }))));
    await render('story', 's1');
    expect(container.textContent).not.toContain('출처 문서');
    expect(container.textContent).toContain('관찰된 참조 0건');
  });

  describe('entityType="doc" — 두 번째 자리 재사용 확인(불규칙복수 파생·재-mount 없이 컴포넌트 변경 0)', () => {
    it('doc 대상이면 /api/docs/{id}/backlinks를 부른다(story→stories와 다른 불규칙복수)', async () => {
      const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({
        data: [{ id: 'r1', source_type: 'chat_message', source_id: 'm1', created_by: null, created_at: '2026-07-28T00:00:00Z', still_exists: true, doc: null, message: { id: 'm1', conversation_id: 'c1', content_snippet: '문서를 가리킨 메시지', sender: null } }],
        meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
      })));
      vi.stubGlobal('fetch', fetchMock);

      await render('doc', 'd1');

      expect(fetchMock).toHaveBeenCalledWith('/api/docs/d1/backlinks', expect.anything());
      expect(container.textContent).toContain('문서를 가리킨 메시지');
    });
  });
});
