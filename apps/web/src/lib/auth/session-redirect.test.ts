import { describe, it, expect } from 'vitest';
import { buildLoginRedirect, safeNextPath, SESSION_EXPIRED_REASON } from './session-redirect';

describe('safeNextPath — 오픈 리다이렉트 가드 (AC3)', () => {
  it('내부 절대경로는 그대로 허용', () => {
    expect(safeNextPath('/board')).toBe('/board');
    expect(safeNextPath('/stories/123?tab=detail')).toBe('/stories/123?tab=detail');
    expect(safeNextPath(encodeURIComponent('/board?x=1'))).toBe('/board?x=1');
  });

  it('외부/프로토콜-상대/백슬래시 유도는 /chats 로 차단', () => {
    expect(safeNextPath('//evil.com')).toBe('/chats');
    expect(safeNextPath('https://evil.com')).toBe('/chats');
    expect(safeNextPath('http://evil.com')).toBe('/chats');
    expect(safeNextPath('/\\evil.com')).toBe('/chats');
    expect(safeNextPath('javascript:alert(1)')).toBe('/chats');
  });

  it('빈/누락/디코드 불가는 /chats', () => {
    expect(safeNextPath(null)).toBe('/chats');
    expect(safeNextPath(undefined)).toBe('/chats');
    expect(safeNextPath('')).toBe('/chats');
    expect(safeNextPath('%')).toBe('/chats'); // decodeURIComponent throw
  });
});

describe('buildLoginRedirect (AC3)', () => {
  it('next(encode) + reason 쿼리를 붙인 /login 경로', () => {
    const r = buildLoginRedirect('/board?x=1');
    expect(r).toContain('/login?');
    expect(r).toContain(`next=${encodeURIComponent('/board?x=1')}`);
    expect(r).toContain(`reason=${SESSION_EXPIRED_REASON}`);
  });

  it('내부경로 아니면 /chats 로 fallback', () => {
    expect(buildLoginRedirect('')).toContain(`next=${encodeURIComponent('/chats')}`);
  });
});

// story #4017(PO 확定 2026-09-17) — chatV3Enabled 인자로 기본 착지를 목적지 모듈과 정렬.
// 생략 시(위 기존 시험들) 기존 동작과 바이트 동일(AC2) — 여기는 그 위에 얹힌 ON 분기만.
describe('safeNextPath/buildLoginRedirect — story #4017 chatV3Enabled', () => {
  it('⭐chatV3Enabled=true면 폴백이 /chat(아직 /chats 아님)', () => {
    expect(safeNextPath(null, true)).toBe('/chat');
    expect(safeNextPath('//evil.com', true)).toBe('/chat');
    expect(buildLoginRedirect('', true)).toContain(`next=${encodeURIComponent('/chat')}`);
  });

  it('chatV3Enabled 생략/false는 기존 /chats 그대로(OFF 바이트 동일)', () => {
    expect(safeNextPath(null, false)).toBe('/chats');
    expect(safeNextPath(null)).toBe('/chats');
    expect(buildLoginRedirect('', false)).toContain(`next=${encodeURIComponent('/chats')}`);
  });

  it('유효한 next가 있으면 chatV3Enabled와 무관하게 그 값 그대로(폴백 분기를 안 탐)', () => {
    expect(safeNextPath('/board', true)).toBe('/board');
  });
});
