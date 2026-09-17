import { describe, it, expect } from 'vitest';
import type { NavV3Flags } from '@/lib/nav-v3-destinations';
import { buildLoginRedirect, safeNextPath, SESSION_EXPIRED_REASON } from './session-redirect';

const OFF_FLAGS: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false };
const CHAT_V3_ON_FLAGS: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: true, connectRulesV3Enabled: false };

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

// story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:31Z) — navV3Flags 인자로 기본
// 착지를 목적지 모듈(resolveNavV3Destinations)에 위임한다(첫 판의 chatV3Enabled
// 불리언 + 자체 '/chat' 리터럴 조립을 반려 — 목적지 문자열은 그 모듈 한 곳에서만).
// 생략 시(위 기존 시험들) 기존 동작과 바이트 동일(AC2) — 여기는 그 위에 얹힌 ON 분기만.
describe('safeNextPath/buildLoginRedirect — story #4017 navV3Flags', () => {
  it('⭐chatV3Enabled=true면 폴백이 /chat(아직 /chats 아님) — resolveNavV3Destinations 위임', () => {
    expect(safeNextPath(null, CHAT_V3_ON_FLAGS)).toBe('/chat');
    expect(safeNextPath('//evil.com', CHAT_V3_ON_FLAGS)).toBe('/chat');
    expect(buildLoginRedirect('', CHAT_V3_ON_FLAGS)).toContain(`next=${encodeURIComponent('/chat')}`);
  });

  it('navV3Flags 생략/전부 OFF는 기존 /chats 그대로(OFF 바이트 동일)', () => {
    expect(safeNextPath(null, OFF_FLAGS)).toBe('/chats');
    expect(safeNextPath(null)).toBe('/chats');
    expect(buildLoginRedirect('', OFF_FLAGS)).toContain(`next=${encodeURIComponent('/chats')}`);
  });

  it('유효한 next가 있으면 navV3Flags와 무관하게 그 값 그대로(폴백 분기를 안 탐)', () => {
    expect(safeNextPath('/board', CHAT_V3_ON_FLAGS)).toBe('/board');
  });
});
