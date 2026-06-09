import { describe, it, expect } from 'vitest'

import { INJECTABLE_EVENT_TYPES, isInjectableEventType } from './inject-allowlist'

// SDK connectors/sdk/sprintable_sse.py 의 INJECTABLE_EVENT_TYPES 와 동일해야 한다(언어 경계 동기화).
const SDK_ALLOWLIST = [
  'dispatched',
  'story_assigned',
  'conversation.message_created',
  'conversation:mention',
  'kickoff',
  'review_request',
  'qa_request',
  'deploy_request',
  'handoff',
]

describe('E-CHAT-CMD S9 — fakechat inject allowlist', () => {
  it('allowlist 가 SDK(sprintable_sse.py) 와 정확히 동일', () => {
    expect(new Set(INJECTABLE_EVENT_TYPES)).toEqual(new Set(SDK_ALLOWLIST))
    expect(INJECTABLE_EVENT_TYPES.size).toBe(SDK_ALLOWLIST.length)
  })

  it('AC1: 허용 event_type 은 data 최상위에서 통과', () => {
    for (const t of SDK_ALLOWLIST) {
      expect(isInjectableEventType({ event_type: t }, {})).toBe(true)
    }
  })

  it('AC1: 허용 event_type 은 payload fallback 에서도 통과', () => {
    expect(isInjectableEventType({}, { event_type: 'conversation.message_created' })).toBe(true)
    // data 최상위 우선 — data 가 허용이면 payload 무관하게 통과
    expect(isInjectableEventType({ event_type: 'dispatched' }, { event_type: 'status_changed' })).toBe(true)
  })

  it('AC2: allowlist 밖 FYI event_type 은 드롭(false) — content 유무 무관', () => {
    const fyi = ['status_changed', 'task_completed', 'agent_joined', 'sprint_closed', 'file_conflict', 'unknown_xyz']
    for (const t of fyi) {
      expect(isInjectableEventType({ event_type: t, content: 'x' }, {})).toBe(false)
      expect(isInjectableEventType({}, { event_type: t, content: 'x' })).toBe(false)
    }
  })

  it('AC2: event_type 부재/비문자열은 드롭(false)', () => {
    expect(isInjectableEventType({}, {})).toBe(false)
    expect(isInjectableEventType({ content: 'x' }, { content: 'y' })).toBe(false)
    expect(isInjectableEventType({ event_type: 123 }, {})).toBe(false)
    expect(isInjectableEventType({ event_type: null }, {})).toBe(false)
  })

  it('회귀: 정상 conversation.message_created 는 통과(무영향)', () => {
    const data = { content: '안녕', conversation_id: 'c1', recipient_seq: 3 }
    const payload = { event_type: 'conversation.message_created', content: '안녕' }
    expect(isInjectableEventType(data, payload)).toBe(true)
  })
})
