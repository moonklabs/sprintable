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

// E-RECRUIT S6 — 디디 BE `GET /api/v2/runtime-capabilities` 착지 前 골격 테스트. 응답 shape은
// 확정 계약(오르테가, 2026-07-06) 그대로: {slug,display_name,supported,tier?,transport,guide_filename,icon?}.
// BE 미착지 상태라 실 fetch 통합은 아직 못 돌리지만, 소비 로직(분리/기본값 보정)은 순수함수로 뽑아둬서
// 지금부터 검증 가능 — BE 착지 즉시 라이브 dev픽셀만 얹으면 된다(이 프로젝트는 jsdom 렌더 테스트 관례가
// SSR 스냅샷(renderToStaticMarkup) 뿐이라 fetch-effect 비동기 렌더 자체는 테스트 인프라 밖).
describe('splitRuntimeCapabilities (E-RECRUIT S6)', () => {
  it('splits the BE-not-deployed fallback into 1 supported + 3 coming-soon, preserving order', () => {
    const { supported, comingSoon } = splitRuntimeCapabilities(RUNTIME_CAPABILITIES_FALLBACK);
    expect(supported.map((r) => r.slug)).toEqual(['claude-code']);
    expect(comingSoon.map((r) => r.slug)).toEqual(['codex', 'gemini', 'cursor']);
  });

  it('splits a hypothetical real BE response (once S6 ships) with multiple supported runtimes', () => {
    const mock: RuntimeCapabilityItem[] = [
      { slug: 'claude-code', display_name: 'Claude Code', supported: true, transport: 'stdio', guide_filename: 'CLAUDE.md' },
      { slug: 'hermes', display_name: 'Hermes', supported: true, transport: 'http', guide_filename: 'CLAUDE.md' },
      { slug: 'opencode', display_name: 'OpenCode', supported: false, transport: 'stdio', guide_filename: 'AGENTS.md' },
    ];
    const { supported, comingSoon } = splitRuntimeCapabilities(mock);
    expect(supported.map((r) => r.slug)).toEqual(['claude-code', 'hermes']);
    expect(comingSoon.map((r) => r.slug)).toEqual(['opencode']);
  });

  it('handles an empty registry (defensive — should never actually happen given the fallback)', () => {
    expect(splitRuntimeCapabilities([])).toEqual({ supported: [], comingSoon: [] });
  });
});

describe('pickDefaultRuntime (E-RECRUIT S6 — avoids recruit() 400 on an unsupported default)', () => {
  const supported: RuntimeCapabilityItem[] = [
    { slug: 'claude-code', display_name: 'Claude Code', supported: true, transport: 'stdio', guide_filename: 'CLAUDE.md' },
    { slug: 'hermes', display_name: 'Hermes', supported: true, transport: 'http', guide_filename: 'CLAUDE.md' },
  ];

  it('keeps the current selection when it is still in the supported list', () => {
    expect(pickDefaultRuntime(supported, 'hermes')).toBe('hermes');
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
