import { describe, it, expect } from 'vitest';

import { listAllowedMcpTokenRefs, mcpTokenRefSchema, resolveMcpTokenRef } from './mcp-secrets';

/**
 * story #3174(보안·EE) — MCP_ALLOWED_TOKEN_REFS 미설정 시 fail-open(빈 allowlist=무제한
 * 허용)이던 기본값을 fail-closed로 정정. 도입 커밋(0fa2c8d42)의 원 테스트가 성공 케이스
 * 마다 매번 MCP_ALLOWED_TOKEN_REFS를 명시로 채워 시험했음에도 정작 라이브러리 코드는
 * "미설정=허용"으로 짜여 있던 drift — 그 drift를 값으로 고정한다.
 *
 * AC3 회귀 3종: 빈/미설정=거부(신규 처방 실증) · 등재=허용(기존 동작 무회귀) ·
 * 미등재=거부(기존에도 있던 동작, 재확認).
 */
describe('resolveMcpTokenRef', () => {
  const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
    ({ ...overrides }) as NodeJS.ProcessEnv;

  it('AC3① — MCP_ALLOWED_TOKEN_REFS 미설정이면 실제 토큰이 존재해도 거부한다(fail-closed)', () => {
    expect(() =>
      resolveMcpTokenRef('MCP_TOKEN_DOCS', env({ MCP_TOKEN_DOCS: 'secret-value' })),
    ).toThrow('token_ref_not_allowlisted: MCP_TOKEN_DOCS');
  });

  it('AC3① — MCP_ALLOWED_TOKEN_REFS가 빈 문자열이어도 거부한다', () => {
    expect(() =>
      resolveMcpTokenRef(
        'MCP_TOKEN_DOCS',
        env({ MCP_TOKEN_DOCS: 'secret-value', MCP_ALLOWED_TOKEN_REFS: '' }),
      ),
    ).toThrow('token_ref_not_allowlisted: MCP_TOKEN_DOCS');
  });

  it('AC3② — 등재된 ref는 여전히 허용된다(무회귀)', () => {
    const token = resolveMcpTokenRef(
      'MCP_TOKEN_DOCS',
      env({ MCP_TOKEN_DOCS: 'secret-value', MCP_ALLOWED_TOKEN_REFS: 'MCP_TOKEN_DOCS' }),
    );
    expect(token).toBe('secret-value');
  });

  it('AC3② — 콤마로 여러 건 등재된 목록 중 하나만 요청해도 허용된다', () => {
    const token = resolveMcpTokenRef(
      'MCP_TOKEN_B',
      env({
        MCP_TOKEN_B: 'b-value',
        MCP_ALLOWED_TOKEN_REFS: 'MCP_TOKEN_A, MCP_TOKEN_B ,MCP_TOKEN_C',
      }),
    );
    expect(token).toBe('b-value');
  });

  it('AC3③ — 미등재 ref는 allowlist가 비어있지 않아도 거부된다(기존 동작 유지)', () => {
    expect(() =>
      resolveMcpTokenRef(
        'MCP_TOKEN_OTHER',
        env({ MCP_TOKEN_OTHER: 'x', MCP_ALLOWED_TOKEN_REFS: 'MCP_TOKEN_DOCS' }),
      ),
    ).toThrow('token_ref_not_allowlisted: MCP_TOKEN_OTHER');
  });

  it('네임스페이스 규제 — MCP_TOKEN_ 접두 아닌 값(예: SUPABASE_SERVICE_ROLE_KEY)은 allowlist 등재 여부와 무관하게 거부', () => {
    expect(() =>
      resolveMcpTokenRef(
        'SUPABASE_SERVICE_ROLE_KEY',
        env({
          SUPABASE_SERVICE_ROLE_KEY: 'leak-me',
          MCP_ALLOWED_TOKEN_REFS: 'SUPABASE_SERVICE_ROLE_KEY',
        }),
      ),
    ).toThrow(/invalid_token_ref_namespace/);
  });

  it('등재+네임스페이스 통과했지만 실제 env 값이 없으면 missing_token_ref', () => {
    expect(() =>
      resolveMcpTokenRef('MCP_TOKEN_DOCS', env({ MCP_ALLOWED_TOKEN_REFS: 'MCP_TOKEN_DOCS' })),
    ).toThrow('missing_token_ref: MCP_TOKEN_DOCS');
  });
});

describe('listAllowedMcpTokenRefs', () => {
  it('미설정/빈 문자열 → 빈 배열', () => {
    expect(listAllowedMcpTokenRefs(undefined)).toEqual([]);
    expect(listAllowedMcpTokenRefs('')).toEqual([]);
    expect(listAllowedMcpTokenRefs('   ')).toEqual([]);
  });

  it('콤마 분리+공백 제거+중복 제거', () => {
    expect(listAllowedMcpTokenRefs('MCP_TOKEN_A, MCP_TOKEN_B ,MCP_TOKEN_A')).toEqual([
      'MCP_TOKEN_A',
      'MCP_TOKEN_B',
    ]);
  });
});

describe('mcpTokenRefSchema', () => {
  it('MCP_TOKEN_ 네임스페이스만 통과', () => {
    expect(mcpTokenRefSchema.safeParse('MCP_TOKEN_DOCS').success).toBe(true);
    expect(mcpTokenRefSchema.safeParse('SUPABASE_SERVICE_ROLE_KEY').success).toBe(false);
    expect(mcpTokenRefSchema.safeParse('').success).toBe(false);
  });
});
