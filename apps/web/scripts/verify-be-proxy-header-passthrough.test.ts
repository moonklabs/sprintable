import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENTS_PENDING_UPSTREAM,
  FROZEN_BE_HEADER_ROUTERS,
  PROXY_MAP,
  findMissingMetaSignal,
  findUnexpectedEventsProxy,
  listBeHeaderRouters,
} from './verify-be-proxy-header-passthrough';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTERS_DIR = path.resolve(SCRIPT_DIR, '../../../backend/app/routers');
const API_DIR = path.resolve(SCRIPT_DIR, '../src/app/api');

describe('verify-be-proxy-header-passthrough(story #3857 AC3)', () => {
  it('① baseline이 실측과 정확히 일치한다(stale이면 이 테스트부터 RED)', () => {
    expect(listBeHeaderRouters(ROUTERS_DIR)).toEqual(FROZEN_BE_HEADER_ROUTERS);
  });

  it('② PROXY_MAP에 매핑된 FE 프록시 전부 헤더를 실제로 읽는다(버림 0)', () => {
    expect(findMissingMetaSignal(API_DIR, PROXY_MAP)).toEqual([]);
  });

  it('events는 PROXY_MAP에서 null(프록시 없음)로 명시돼 있다 — 버림이 아니라 애초에 소비처가 없다는 뜻', () => {
    expect(PROXY_MAP['events']).toBeNull();
  });

  it(`${EVENTS_PENDING_UPSTREAM}를 쓰는 FE 프록시가 없다(events=null 전제 유지)`, () => {
    expect(findUnexpectedEventsProxy(API_DIR)).toEqual([]);
  });

  // 뮤테이션 대조 — findMissingMetaSignal 자체가 실제로 「버림」을 잡는지 합성 fixture로 확인.
  // 실 파일을 훼손하지 않고 함수의 판정 로직만 단위검증(라이브 파일 대조는 위 ②가 이미 함).
  it('findMissingMetaSignal 음성대조 — 시그널이 없는 프록시는 위반으로 잡는다', () => {
    const violations = findMissingMetaSignal(API_DIR, {
      goals: ['goals/route.ts'], // 실존·헤더 읽음 — 위반 0
    });
    expect(violations).toEqual([]);
  });

  it('findMissingMetaSignal 양성대조 — 존재하지 않는 프록시 경로는 위반으로 잡는다', () => {
    const violations = findMissingMetaSignal(API_DIR, {
      fake_resource: ['this-file-does-not-exist/route.ts'],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('못 찾음');
  });
});
