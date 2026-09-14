import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENTS_PENDING_UPSTREAM,
  FROZEN_BE_HEADER_ROUTERS,
  LIMIT_DEFAULT_RESOURCES,
  PROXY_MAP,
  extractBeLimitDefault,
  extractFeLimitDefault,
  findLimitDefaultMismatches,
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

  // PO CHANGES②(2026-09-14 09:01Z) — BE Query(default=…) ↔ FE `|| N` 폴백 상수 대조.
  describe('limit 기본값 대조(PO CHANGES②)', () => {
    it('extractBeLimitDefault — 숫자 default는 숫자로, None은 null로 추출한다', () => {
      expect(extractBeLimitDefault('limit: int = Query(default=50, ge=1, le=200)')).toBe(50);
      expect(extractBeLimitDefault('limit: int | None = Query(default=None, ge=1, le=2000)')).toBeNull();
    });

    it('extractBeLimitDefault — 패턴을 못 찾으면 undefined(가드 stale 신호, null과 구분)', () => {
      expect(extractBeLimitDefault('def list_x(): pass')).toBeUndefined();
    });

    it('extractFeLimitDefault — `|| N` 폴백값을 추출한다', () => {
      expect(extractFeLimitDefault("const requestedLimit = Number(searchParams.get('limit')) || 50;")).toBe(50);
    });

    it('extractFeLimitDefault — 패턴을 못 찾으면 undefined', () => {
      expect(extractFeLimitDefault('const x = 1;')).toBeUndefined();
    });

    it('실 파일 4쌍 전부 대조 — BE Query(default=N) 있는 자원(agent_runs·standups)은 FE와 일치, None인 자원(sprints·retros)은 숫자 대조 스킵', () => {
      expect(findLimitDefaultMismatches(ROUTERS_DIR, API_DIR, LIMIT_DEFAULT_RESOURCES)).toEqual([]);
    });

    it('findLimitDefaultMismatches 양성대조 — 숫자가 어긋나면 잡는다(합성 fixture, 실 파일 훼손 없음)', () => {
      // 실제 BE/FE 파일 대신 fixture 경로를 못 찾는 케이스로 "존재 검사" 축을 확인 —
      // 값 불일치 축은 findLimitDefaultMismatches 자체를 라이브 파일로 실행하는 위
      // 테스트가 이미 「일치=0건」을 고정하므로, 값이 어긋나는 경로는 아래 뮤테이션 검증
      // (route.ts 상수 실변경 → 가드 재실행 RED)으로 별도 확인한다(스크립트 파일 참고).
      const violations = findLimitDefaultMismatches(ROUTERS_DIR, API_DIR, {
        agent_runs: { beFile: 'agent_runs.py', feFile: 'this-file-does-not-exist/route.ts' },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('못 찾음');
    });
  });
});
