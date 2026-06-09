import { describe, it, expect } from 'vitest';

import { commandName, dequoteLiteral, isCommand } from './command-classifier';

/**
 * Parity 테스트 — `backend/app/services/command_classifier.py` 규칙과 일치 어서트(drift 가드).
 * BE `_COMMAND_RE = ^/[a-zA-Z]\S*` · `dequote_literal`(선행 // → / 1개 제거) · name=슬래시 뒤 첫 토큰.
 * BE 규칙이 바뀌면 이 테스트가 깨져 FE 미러 동기화를 강제한다.
 */
describe('command-classifier — BE parity', () => {
  describe('isCommand (^/[a-zA-Z])', () => {
    it('`/review` → command', () => expect(isCommand('/review')).toBe(true));
    it('`/review foo` → command', () => expect(isCommand('/review foo')).toBe(true));
    it('선행 공백 ` /review` → not command', () => expect(isCommand(' /review')).toBe(false));
    it('`//review` (escape) → not command', () => expect(isCommand('//review')).toBe(false));
    it('`/` 단독 → not command', () => expect(isCommand('/')).toBe(false));
    it('`/123` (비영문자) → not command', () => expect(isCommand('/123')).toBe(false));
    it('`/리뷰` (비-ASCII) → not command', () => expect(isCommand('/리뷰')).toBe(false));
    it('평문 → not command', () => expect(isCommand('hello /review')).toBe(false));
    it('null/빈값 → not command', () => {
      expect(isCommand(null)).toBe(false);
      expect(isCommand(undefined)).toBe(false);
      expect(isCommand('')).toBe(false);
    });
  });

  describe('dequoteLiteral (// → / 1개)', () => {
    it('`//review` → `/review`', () => expect(dequoteLiteral('//review')).toBe('/review'));
    it('`//review foo` → `/review foo`', () => expect(dequoteLiteral('//review foo')).toBe('/review foo'));
    it('`/review` 무변경', () => expect(dequoteLiteral('/review')).toBe('/review'));
    it('평문 무변경', () => expect(dequoteLiteral('hello')).toBe('hello'));
    it('`///x` → `//x` (1개만 제거)', () => expect(dequoteLiteral('///x')).toBe('//x'));
  });

  describe('commandName (슬래시 뒤 첫 토큰)', () => {
    it('`/review` → `review`', () => expect(commandName('/review')).toBe('review'));
    it('`/review foo bar` → `review`', () => expect(commandName('/review foo bar')).toBe('review'));
    it('`/review  ` (트레일링) → `review`', () => expect(commandName('/review  ')).toBe('review'));
    it('비-커맨드 → null', () => {
      expect(commandName('//review')).toBeNull();
      expect(commandName(' /review')).toBeNull();
      expect(commandName('hi')).toBeNull();
      expect(commandName(null)).toBeNull();
    });
  });
});
