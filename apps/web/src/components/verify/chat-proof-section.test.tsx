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
  it('proof+chat_message 조합만 통과시킨다 — 다른 form/target은 skippedIds에도 안 잡힌다(후보가 아니므로)', () => {
    const { items, skippedIds } = parseStoryProofReferences({
      data: [VALID_ROW, { ...VALID_ROW, id: 'ref-2', form: 'mention' }, { ...VALID_ROW, id: 'ref-3', target_type: 'doc' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('ref-1');
    expect(skippedIds).toEqual([]);
  });

  it('{data:[...]}·bare 배열 둘 다 받는다', () => {
    expect(parseStoryProofReferences({ data: [VALID_ROW] }).items).toHaveLength(1);
    expect(parseStoryProofReferences([VALID_ROW]).items).toHaveLength(1);
  });

  it('proof_payload가 없으면(아직 BE가 안 실어주는 옛 응답) 그 항목을 items에서 생략하고 skippedIds에 센다', () => {
    const { proof_payload: _omit, ...withoutPayload } = VALID_ROW;
    const { items, skippedIds } = parseStoryProofReferences({ data: [withoutPayload] });
    expect(items).toHaveLength(0);
    expect(skippedIds).toEqual(['ref-1']);
  });

  it('snapshot이 배열이 아니거나 항목 형상이 깨지면 그 항목만 skippedIds로 가고 다른 항목은 items에 살아남는다', () => {
    const broken = { ...VALID_ROW, id: 'ref-broken', proof_payload: { ...VALID_ROW.proof_payload, snapshot: 'not-an-array' } };
    const { items, skippedIds } = parseStoryProofReferences({ data: [broken, VALID_ROW] });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('ref-1');
    expect(skippedIds).toEqual(['ref-broken']);
  });

  it('still_exists가 boolean이 아니면 null로 정직하게 취급한다(모름을 false로 지어내지 않는다)', () => {
    const noFlag = { ...VALID_ROW, still_exists: undefined };
    const { items } = parseStoryProofReferences({ data: [noFlag] });
    expect(items[0]!.stillExists).toBeNull();
  });

  it('malformed 최상위 입력(null·문자열·빈 객체)은 전부 items·skippedIds 둘 다 빈 배열', () => {
    for (const input of [null, 'oops', {}]) {
      const { items, skippedIds } = parseStoryProofReferences(input);
      expect(items).toEqual([]);
      expect(skippedIds).toEqual([]);
    }
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
  it('참조가 0건이고 생략도 0건이면 섹션 자체를 null 렌더한다(EvidenceSection과 동일 관례)', async () => {
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

  it('생략된 항목이 있으면 items가 0건이어도 섹션이 뜨고 "표시할 수 없음" 수를 보인다(모름이 괜찮음으로 안 사라짐, PO 지적 2026-07-29)', async () => {
    const { proof_payload: _omit, ...broken } = VALID_ROW;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [broken] }) })));
    await act(async () => { root.render(wrap(<ChatProofSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('1건은 표시할 수 없음');
  });

  it('생략된 항목이 있으면 개발환경에서 console.warn으로 남긴다(다음 사람이 왜 안 뜨는지 볼 수 있게)', async () => {
    const { proof_payload: _omit, ...broken } = VALID_ROW;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [broken] }) })));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => { root.render(wrap(<ChatProofSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(warnSpy).toHaveBeenCalledWith(
      'ChatProofSection: skipped malformed proof reference(s)',
      expect.objectContaining({ storyId: 'story-1', skippedIds: ['ref-1'] }),
    );
    warnSpy.mockRestore();
  });

  it('생략 없이 정상 항목만 있으면 console.warn을 안 부른다(노이즈 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [VALID_ROW] }) })));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => { root.render(wrap(<ChatProofSection storyId="story-1" />)); });
    await act(async () => { await Promise.resolve(); });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
