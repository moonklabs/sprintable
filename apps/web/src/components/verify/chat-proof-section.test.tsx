// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatProofSection, parseStoryProofReferences } from './chat-proof-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const VALID_ROW = {
  id: 'ref-1',
  form: 'proof',
  target_type: 'chat_message',
  target_id: 'msg-1',
  created_at: '2026-07-29T00:00:00.000Z',
  still_exists: true,
  proof_payload: {
    conversation_id: 'conv-1',
    start_message_id: 'msg-1',
    end_message_id: 'msg-2',
    snapshot: [
      { message_id: 'msg-1', author_id: 'member-1', content: '이 방향으로 가시는', created_at: '2026-07-28T00:00:00.000Z' },
    ],
  },
};

describe('parseStoryProofReferences — story #2265(C-7) PR1b 파싱', () => {
  it('proof+chat_message 조합만 통과시킨다', () => {
    const out = parseStoryProofReferences({
      data: [VALID_ROW, { ...VALID_ROW, id: 'ref-2', form: 'mention' }, { ...VALID_ROW, id: 'ref-3', target_type: 'doc' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('ref-1');
  });

  it('{data:{data:[...]}} 이중포장·{data:[...]}·bare 배열 셋 다 받는다', () => {
    expect(parseStoryProofReferences({ data: [VALID_ROW] })).toHaveLength(1);
    expect(parseStoryProofReferences([VALID_ROW])).toHaveLength(1);
  });

  it('proof_payload가 없으면(아직 BE가 안 실어주는 옛 응답) 그 항목을 생략한다 — 지어내지 않는다', () => {
    const { proof_payload: _omit, ...withoutPayload } = VALID_ROW;
    const out = parseStoryProofReferences({ data: [withoutPayload] });
    expect(out).toHaveLength(0);
  });

  it('snapshot이 배열이 아니거나 항목 형상이 깨지면 그 항목만 생략한다(다른 항목은 살아남는다)', () => {
    const broken = { ...VALID_ROW, id: 'ref-broken', proof_payload: { ...VALID_ROW.proof_payload, snapshot: 'not-an-array' } };
    const out = parseStoryProofReferences({ data: [broken, VALID_ROW] });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('ref-1');
  });

  it('still_exists가 boolean이 아니면 null로 정직하게 취급한다(모름을 false로 지어내지 않는다)', () => {
    const noFlag = { ...VALID_ROW, still_exists: undefined };
    const out = parseStoryProofReferences({ data: [noFlag] });
    expect(out[0]!.stillExists).toBeNull();
  });

  it('malformed 최상위 입력(null·문자열·빈 객체)은 전부 빈 배열', () => {
    expect(parseStoryProofReferences(null)).toEqual([]);
    expect(parseStoryProofReferences('oops')).toEqual([]);
    expect(parseStoryProofReferences({})).toEqual([]);
  });
});

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
});

describe('ChatProofSection — story #2265(C-7) PR1b 섹션 렌더', () => {
  it('참조가 0건이면 섹션 자체를 null 렌더한다(EvidenceSection과 동일 관례)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(wrap(<ChatProofSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
  });

  it('참조가 있으면 인용 카드를 그리고 개수를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [VALID_ROW] }) })));
    await act(async () => { root.render(wrap(<ChatProofSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('이 방향으로 가시는');
    expect(container.textContent).toContain('1');
  });

  it('fetch 실패 시 크래시 없이 빈 상태(null 렌더)로 graceful degrade한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await act(async () => { root.render(wrap(<ChatProofSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
  });

  it('still_exists=false인 항목은 삭제됨 상태로 렌더한다(내용 숨김·삭제됨 표지)', async () => {
    const deleted = { ...VALID_ROW, still_exists: false };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [deleted] }) })));
    await act(async () => { root.render(wrap(<ChatProofSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).not.toContain('이 방향으로 가시는');
    expect(container.textContent).toContain('삭제됨');
  });
});
