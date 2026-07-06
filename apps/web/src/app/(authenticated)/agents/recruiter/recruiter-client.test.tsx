import { describe, expect, it } from 'vitest';
import { spliceApiKey, splitRuntimeCapabilities, pickDefaultRuntime } from './recruiter-client';
import type { McpConfigBundle, RuntimeCapabilityItem } from '@/services/recruit';
import { RUNTIME_CAPABILITIES_FALLBACK } from '@/services/recruit';

describe('spliceApiKey (까심 QA RC HIGH① — transport별 키 위치)', () => {
  it('replaces the key in headers.Authorization for the http (hosted) shape', () => {
    const bundle: McpConfigBundle = {
      mcpServers: { sprintable: { type: 'http', url: 'https://mcp.sprintable.ai/mcp', headers: { Authorization: 'Bearer sk_live_old', 'X-Project-Id': 'p1' } } },
    };
    const result = spliceApiKey(bundle, 'sk_live_new');
    expect(result?.mcpServers.sprintable.headers?.Authorization).toBe('Bearer sk_live_new');
    expect(result?.mcpServers.sprintable.headers?.['X-Project-Id']).toBe('p1'); // 다른 필드 보존
  });

  it('replaces the key in env.AGENT_API_KEY for the stdio (local) shape — the bug 까심 caught', () => {
    const bundle: McpConfigBundle = {
      mcpServers: { sprintable: { type: 'stdio', command: 'uvx', args: ['sprintable-mcp'], env: { SPRINTABLE_API_URL: 'https://api.example.com', AGENT_API_KEY: 'sk_live_old' } } },
    };
    const result = spliceApiKey(bundle, 'sk_live_new');
    expect(result?.mcpServers.sprintable.env?.AGENT_API_KEY).toBe('sk_live_new');
    expect(result?.mcpServers.sprintable.env?.SPRINTABLE_API_URL).toBe('https://api.example.com'); // 다른 필드 보존
  });

  it('returns null (never silently stale) when neither key location is present', () => {
    const bundle: McpConfigBundle = { mcpServers: { sprintable: { type: 'stdio', command: 'uvx' } } };
    expect(spliceApiKey(bundle, 'sk_live_new')).toBeNull();
  });
});

// E-RECRUIT S6 — 디디 BE PR #1911(`GET /api/v2/runtime-capabilities`) 착지 후 실제 계약으로 정정.
// 착수 시점에 전달받은 요약(`transport`3값 리터럴·`guide_filename`이 일반 필드)과 실제 스키마가
// 달라(connector도 정식 레지스트리 slug·지침파일=`prompt_file`) PR diff를 직접 읽고 타입을 맞췄다.
// 아래 REAL_BE_RESPONSE는 PR #1911 브랜치를 로컬 uvicorn(포트 8001, 기존 공유 로컬 Postgres 재사용)
// 으로 직접 띄워 curl로 받은 실 응답 그대로(2026-07-06) — 추측이 아니라 실측 고정.

/** BE PR #1911 실측 계약 기준 최소 필드 채움 헬퍼 — 테스트에서 관심 없는 필드는 디폴트로. */
function mkCap(overrides: Partial<RuntimeCapabilityItem> & Pick<RuntimeCapabilityItem, 'slug' | 'display_name' | 'supported'>): RuntimeCapabilityItem {
  return {
    tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null,
    supports_event_push: false, icon: null,
    ...overrides,
  };
}

describe('splitRuntimeCapabilities (E-RECRUIT S6)', () => {
  it('splits the BE-not-deployed fallback into 1 supported + 3 coming-soon, preserving order', () => {
    const { supported, comingSoon } = splitRuntimeCapabilities(RUNTIME_CAPABILITIES_FALLBACK);
    expect(supported.map((r) => r.slug)).toEqual(['claude-code']);
    expect(comingSoon.map((r) => r.slug)).toEqual(['codex', 'gemini', 'cursor']);
  });

  it('splits a real BE response (PR #1911) with multiple supported runtimes, incl. connector as a normal entry', () => {
    const mock: RuntimeCapabilityItem[] = [
      mkCap({ slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', prompt_file: 'CLAUDE.md' }),
      mkCap({ slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', guide_filename: 'CONNECTOR_SETUP.md' }),
      mkCap({ slug: 'opencode', display_name: 'OpenCode', supported: false }),
    ];
    const { supported, comingSoon } = splitRuntimeCapabilities(mock);
    expect(supported.map((r) => r.slug)).toEqual(['claude-code', 'connector']);
    expect(comingSoon.map((r) => r.slug)).toEqual(['opencode']);
  });

  it('handles an empty registry (defensive — should never actually happen given the fallback)', () => {
    expect(splitRuntimeCapabilities([])).toEqual({ supported: [], comingSoon: [] });
  });
});

describe('pickDefaultRuntime (E-RECRUIT S6 — avoids recruit() 400 on an unsupported default)', () => {
  const supported: RuntimeCapabilityItem[] = [
    mkCap({ slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', prompt_file: 'CLAUDE.md' }),
    mkCap({ slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', guide_filename: 'CONNECTOR_SETUP.md' }),
  ];

  it('keeps the current selection when it is still in the supported list', () => {
    expect(pickDefaultRuntime(supported, 'connector')).toBe('connector');
  });

  it('falls back to the first supported runtime when the current selection is not supported', () => {
    // e.g. the default 'claude-code' state got orphaned because the registry no longer lists it first,
    // or a stale selection from a previous fetch is no longer present.
    expect(pickDefaultRuntime(supported, 'gemini')).toBe('claude-code');
  });

  it('leaves the current value untouched when the supported list is empty (defensive, never crashes)', () => {
    expect(pickDefaultRuntime([], 'claude-code')).toBe('claude-code');
  });
});

// 실측: PR #1911 브랜치를 로컬 uvicorn(8001)으로 띄우고 실 사용자 JWT로 curl한 그대로(2026-07-06,
// 순서는 BE가 slug 알파벳순 정렬해 반환한 그대로 보존). 이 고정값이 실제로 바뀌면 계약 드리프트니
// 이 테스트가 먼저 깨져야 한다(회귀 가드).
const REAL_BE_RESPONSE: RuntimeCapabilityItem[] = [
  { slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'CLAUDE.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'codex', display_name: 'Codex', supported: true, tier: 'experimental', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENT_INSTRUCTIONS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', transport: null, mcp_transport: [], prompt_file: 'AGENT_INSTRUCTIONS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'cursor', display_name: 'Cursor', supported: true, tier: 'experimental', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENT_INSTRUCTIONS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'gemini', display_name: 'Gemini', supported: true, tier: 'experimental', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENT_INSTRUCTIONS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'grok', display_name: 'Grok', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
  { slug: 'hermes', display_name: 'Hermes', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
  { slug: 'openclaw', display_name: 'OpenClaw', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
  { slug: 'opencode', display_name: 'OpenCode', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
  { slug: 'pi', display_name: 'Pi', supported: false, tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null, supports_event_push: false, icon: null },
];

describe('E-RECRUIT S6 — against the real captured GET /api/v2/runtime-capabilities response', () => {
  it('splits into 5 supported (incl. connector) and 5 coming-soon', () => {
    const { supported, comingSoon } = splitRuntimeCapabilities(REAL_BE_RESPONSE);
    expect(supported.map((r) => r.slug)).toEqual(['claude-code', 'codex', 'connector', 'cursor', 'gemini']);
    expect(comingSoon.map((r) => r.slug)).toEqual(['grok', 'hermes', 'openclaw', 'opencode', 'pi']);
  });

  it('exactly claude-code is tier=full (no badge); the other 4 supported are experimental (badge)', () => {
    const { supported } = splitRuntimeCapabilities(REAL_BE_RESPONSE);
    const experimental = supported.filter((r) => r.tier === 'experimental').map((r) => r.slug);
    const full = supported.filter((r) => r.tier === 'full').map((r) => r.slug);
    expect(full).toEqual(['claude-code']);
    expect(experimental).toEqual(['codex', 'connector', 'cursor', 'gemini']);
  });

  it('default runtime stays claude-code (already first + tier=full)', () => {
    const { supported } = splitRuntimeCapabilities(REAL_BE_RESPONSE);
    expect(pickDefaultRuntime(supported, 'claude-code')).toBe('claude-code');
  });

  it("guideFilename derivation source: prompt_file carries the real per-runtime filename, guide_filename is connector-only", () => {
    const bySlug = Object.fromEntries(REAL_BE_RESPONSE.map((r) => [r.slug, r]));
    expect(bySlug['claude-code'].prompt_file).toBe('CLAUDE.md');
    expect(bySlug['codex'].prompt_file).toBe('AGENT_INSTRUCTIONS.md'); // generic fallback pre-S7 shaping
    expect(bySlug['connector'].guide_filename).toBe('CONNECTOR_SETUP.md');
    expect(bySlug['claude-code'].guide_filename).toBeNull(); // NOT where the regular filename lives
  });
});
