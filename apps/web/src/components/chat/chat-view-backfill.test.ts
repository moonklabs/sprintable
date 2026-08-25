// story #3081(선생님 P0 지시, 2026-08-25) — codex 재검증 정본 ③·⑤ 회귀가드. ChatView
// 전체(1097줄, ThreadPanel·ReadingPanel·chat-rail-context 등 무거운 의존성)를 마운트하지
// 않고, 그 안에서 뽑아낸 순수함수 두 개(mergeBackfilledMessages·resolveBackfillMarkReadIso)
// 만 직접 검증한다 — 이 파일이 실제 배선(chat-view.tsx의 fetchMessages/handleReconnect)에
// 물려 있는지는 소스 대조로 확인했다(그 두 함수를 그대로 호출).
import { describe, expect, it } from 'vitest';
import { mergeBackfilledMessages, resolveBackfillMarkReadIso } from './chat-view';
import type { ChatMessage } from '@/hooks/use-chat-sse';

function msg(id: string, created_at: string): ChatMessage {
  return {
    id, memo_id: 'c1', created_by: 'u1', sender_name: 'test', sender_type: 'human',
    sender_avatar_url: null, content: id, attachments: [], created_at,
  };
}

describe('mergeBackfilledMessages — story #3081 정본 ⑤', () => {
  it('data가 비어있으면 prev를 그대로 반환한다(재연결 직후 응답이 빈 페이지인 경우)', () => {
    const prev = [msg('a', '2026-08-25T00:00:00Z')];
    expect(mergeBackfilledMessages(prev, [])).toBe(prev);
  });

  it('과거로 스크롤해 loadMore로 펼쳐 둔 옛 페이지를 날리지 않는다(핵심 회귀 — 옛날엔 setMessages(data)로 통째 교체했다)', () => {
    const oldPage = [msg('old-1', '2026-08-20T00:00:00Z'), msg('old-2', '2026-08-21T00:00:00Z')];
    const freshLatest = [msg('new-1', '2026-08-25T09:00:00Z'), msg('new-2', '2026-08-25T09:05:00Z')];
    const result = mergeBackfilledMessages(oldPage, freshLatest);
    expect(result.map((m) => m.id)).toEqual(['old-1', 'old-2', 'new-1', 'new-2']);
  });

  it('data와 겹치는 id는 prev 쪽을 버리고 새 값을 신뢰한다(dedup)', () => {
    const prev = [msg('old-1', '2026-08-20T00:00:00Z'), msg('shared', '2026-08-25T09:00:00Z')];
    const data = [msg('shared', '2026-08-25T09:00:00Z'), msg('new-1', '2026-08-25T09:05:00Z')];
    const result = mergeBackfilledMessages(prev, data);
    expect(result.map((m) => m.id)).toEqual(['old-1', 'shared', 'new-1']);
    expect(result.filter((m) => m.id === 'shared')).toHaveLength(1);
  });

  it('prev 항목이 data[0]보다 최신(=신규 페이지 구간에 포함)이면 보존하지 않는다', () => {
    const prev = [msg('stale-mid', '2026-08-25T09:02:00Z')]; // data[0]보다 최신 — 신규 구간 내부
    const data = [msg('new-1', '2026-08-25T09:00:00Z'), msg('new-2', '2026-08-25T09:05:00Z')];
    const result = mergeBackfilledMessages(prev, data);
    expect(result.map((m) => m.id)).toEqual(['new-1', 'new-2']); // stale-mid는 빠진다(신규분이 정답)
  });
});

describe('resolveBackfillMarkReadIso — story #3081 정본 ③', () => {
  it('하단 근처(nearBottom=true)에서 backfill로 신규 메시지가 채워지면 최신 시각을 반환한다', () => {
    const latest = [msg('a', '2026-08-25T09:00:00Z'), msg('b', '2026-08-25T09:05:00Z')];
    expect(resolveBackfillMarkReadIso(latest, true)).toBe('2026-08-25T09:05:00Z');
  });

  it('하단이 아니면(스크롤 위) mark-read하지 않는다 — null', () => {
    const latest = [msg('a', '2026-08-25T09:00:00Z')];
    expect(resolveBackfillMarkReadIso(latest, false)).toBeNull();
  });

  it('backfill 결과가 비어있으면(신규 메시지 없음) null', () => {
    expect(resolveBackfillMarkReadIso([], true)).toBeNull();
  });

  it('fetchMessages가 실패해 undefined를 반환해도 안전하게 null', () => {
    expect(resolveBackfillMarkReadIso(undefined, true)).toBeNull();
  });
});
