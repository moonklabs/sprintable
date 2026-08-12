// story #2583 S1 — formatEnvelopeText() 핀 테스트 + 오호칭 봉쇄(AC2) 최소 렌더 계약.
// 같은 샘플 입력·같은 기댓값 문자열이 test_envelope_format.py(Python side)에도 핀
// 고정돼 있다 — 이쪽 렌더 규칙을 고치면 그쪽 테스트가 깨진다(#2589 언어-경계 동기
// 가드 패턴 재사용). 배경: doc 2583-injection-envelope-recon-20260812.
import { test, expect } from 'bun:test'
import { formatEnvelopeText, type MessageContext } from './sprintable-sse'

function ctx(overrides: Partial<MessageContext>): MessageContext {
  return {
    content: '', conversationId: '', senderId: '', senderName: '',
    eventId: 'e1', seq: 1, isBackfill: false, attachments: [], raw: {},
    senderType: '', eventKind: '', ts: '',
    reply: async () => {},
    ...overrides,
  }
}

test('pinned: full envelope renders in the exact expected shape', () => {
  const c = ctx({
    content: '안녕하세요',
    conversationId: 'conv-abc-123',
    senderName: '송윤재',
    senderType: 'human',
    eventKind: 'conversation.message_created',
    ts: '2026-08-12T10:00:00Z',
  })
  const expected =
    '[conversation.message_created] 송윤재 (human) · conv=conv-abc-123 · ts=2026-08-12T10:00:00Z\n안녕하세요'
  expect(formatEnvelopeText(c)).toBe(expected)
})

test('missing fields render as "unknown", never fabricated (AC1)', () => {
  const c = ctx({ content: '본문만 있음', senderName: '누군가', conversationId: 'conv-known' })
  const out = formatEnvelopeText(c)
  expect(out.split('unknown').length - 1).toBe(3) // senderType/eventKind/ts만 unknown
  expect(out).toContain('conv=conv-known') // 채워진 필드는 unknown으로 안 덮임
})

test('misaddressing scenario blocked (AC2) — sender never leaks across two sends', () => {
  const first = ctx({
    content: '통신점검', conversationId: 'conv-1',
    senderName: '페드루 올리베이라', senderType: 'agent',
    eventKind: 'conversation.message_created', ts: '2026-08-12T09:00:00Z',
  })
  const second = ctx({
    content: '이거 다시 봐줘', conversationId: 'conv-1',
    senderName: '송윤재', senderType: 'human',
    eventKind: 'conversation.message_created', ts: '2026-08-12T09:05:00Z',
  })
  const renderedFirst = formatEnvelopeText(first)
  const renderedSecond = formatEnvelopeText(second)

  expect(renderedFirst).toContain('페드루 올리베이라')
  expect(renderedFirst).toContain('(agent)')
  expect(renderedSecond).toContain('송윤재')
  expect(renderedSecond).toContain('(human)')
  // 직전 발신자 계승(오호칭 사고 재현) 여부 확인.
  expect(renderedSecond).not.toContain('페드루 올리베이라')

  const [headerLine, bodyLine] = renderedSecond.split('\n')
  expect(headerLine).toContain('송윤재')
  expect(bodyLine).toBe('이거 다시 봐줘')
})
