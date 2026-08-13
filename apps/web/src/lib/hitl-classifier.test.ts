import { describe, it, expect } from 'vitest';

import { formatHitlReply, isHitlReply, parseHitlRequest } from './hitl-classifier';

/**
 * Parity 테스트 — sprintable-claude-plugin(별도 레포) `plugins/sprintable/server.ts`
 * `requestApproval()`(요청 포맷)·PreToolUse 답 파싱(`/^\s*(allow|deny)\b\s*(.*)$/i`)과의
 * 계약 어서트(drift 가드). 플러그인은 이 저장소 밖이라(story #2572 하드 제약 「플러그인 변경
 * 0」) 이 파일이 그쪽 문구를 그대로 미러한다 — 플러그인 쪽 문구가 바뀌면 이 테스트가 깨져
 * 동기화를 강제한다.
 */
describe('hitl-classifier — 플러그인 parity', () => {
  const REAL = '🔒 승인 요청: `Bash`\n입력: {"command":"rm -rf /tmp/x"}\n\n「allow」 또는 「deny <사유>」로 답해주세요 (600초 내 무응답 시 자동 거부).';

  describe('parseHitlRequest', () => {
    it('플러그인 고정 포맷을 정확히 파싱한다', () => {
      const parsed = parseHitlRequest(REAL);
      expect(parsed).toEqual({
        toolName: 'Bash',
        inputSummary: '{"command":"rm -rf /tmp/x"}',
        timeoutSec: 600,
      });
    });

    it('타임아웃 초가 다른 값이어도(env override) 파싱된다', () => {
      const custom = REAL.replace('600초', '30초');
      expect(parseHitlRequest(custom)?.timeoutSec).toBe(30);
    });

    it('null/undefined/빈 문자열 → null', () => {
      expect(parseHitlRequest(null)).toBeNull();
      expect(parseHitlRequest(undefined)).toBeNull();
      expect(parseHitlRequest('')).toBeNull();
    });

    it('일반 텍스트 → null(카드화 안 함)', () => {
      expect(parseHitlRequest('안녕하세요')).toBeNull();
    });

    it('사람이 같은 문구를 손으로 쳐도 파서 자체는 매칭한다 — 카드화 게이트는 sender_type이 별도로 건다', () => {
      // PO 가드①(오탐 방지)은 chat-bubble.tsx의 isAgent 게이트 몫 — 이 파서는 순수 텍스트
      // 매칭만 한다. 이 테스트는 그 책임 분리를 문서화한다.
      expect(parseHitlRequest(REAL)).not.toBeNull();
    });

    it('선두 문구가 살짝 달라지면(플러그인 드리프트) → null(깨진 카드 대신 폴백)', () => {
      expect(parseHitlRequest(REAL.replace('🔒 승인 요청', '🔒 승인요청'))).toBeNull();
    });

    it('안내 문장이 달라지면(플러그인 드리프트) → null', () => {
      expect(parseHitlRequest(REAL.replace('「allow」 또는 「deny <사유>」로 답해주세요', 'allow나 deny로 답해주세요'))).toBeNull();
    });

    it('마침표 누락 등 말단이 어긋나면 → null', () => {
      expect(parseHitlRequest(REAL.slice(0, -1))).toBeNull();
    });

    it('toolName에 백틱이 없으면(포맷 붕괴) → null', () => {
      expect(parseHitlRequest(REAL.replace('`Bash`', 'Bash'))).toBeNull();
    });
  });

  describe('formatHitlReply — 답 문자열이 플러그인 파싱 regex(/^\\s*(allow|deny)\\b\\s*(.*)$/i)와 왕복', () => {
    it("allow → 'allow'", () => expect(formatHitlReply('allow')).toBe('allow'));
    it("deny(사유 없음) → 'deny'", () => expect(formatHitlReply('deny')).toBe('deny'));
    it("deny + 사유 → 'deny <사유>'", () => expect(formatHitlReply('deny', '위험한 명령')).toBe('deny 위험한 명령'));
    it('deny + 공백만인 사유 → 사유 없이 deny', () => expect(formatHitlReply('deny', '   ')).toBe('deny'));
    it('allow는 사유를 넘겨도 무시한다(플러그인이 allow에선 message를 안 씀)', () => {
      expect(formatHitlReply('allow', '무시될 사유')).toBe('allow');
    });
  });

  describe('isHitlReply — server.ts:466 regex 미러', () => {
    it("'allow' → {decision:'allow'}", () => expect(isHitlReply('allow')).toEqual({ decision: 'allow' }));
    it("'ALLOW'(대소문자 무관) → allow", () => expect(isHitlReply('ALLOW')).toEqual({ decision: 'allow' }));
    it("'deny 위험함' → {decision:'deny', reason:'위험함'}", () => {
      expect(isHitlReply('deny 위험함')).toEqual({ decision: 'deny', reason: '위험함' });
    });
    it('선행 공백 허용', () => expect(isHitlReply('  allow')).toEqual({ decision: 'allow' }));
    it('무관한 텍스트 → null', () => expect(isHitlReply('안녕')).toBeNull());
    it('null/undefined → null', () => {
      expect(isHitlReply(null)).toBeNull();
      expect(isHitlReply(undefined)).toBeNull();
    });
  });
});
