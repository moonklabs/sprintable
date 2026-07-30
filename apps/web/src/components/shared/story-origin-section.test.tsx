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

  it('fetch 실패 시 조용히 아무것도 안 그린다(EntityBacklinksSection과 동형)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await render('s1');
    expect(container.textContent).toBe('');
  });
});
