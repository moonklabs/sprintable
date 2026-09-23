import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { buildCodexConfigToml } from './codex-mcp-config';
import type { McpConfigBundle } from '@/services/recruit';

describe('buildCodexConfigToml', () => {
  it('stdio 변형 — 실 파서로 파싱되고 command/args/env가 그대로 실린다', () => {
    const bundle: McpConfigBundle = {
      mcpServers: {
        'sprintable-mcp': {
          type: 'stdio',
          command: 'uvx',
          args: ['sprintable'],
          env: {
            SPRINTABLE_API_URL: 'https://backend.example.run.app',
            AGENT_GATEWAY_V2: '1',
            AGENT_API_KEY: 'sk_live_abc123',
          },
        },
      },
    };
    const toml = buildCodexConfigToml(bundle);
    const parsed = parse(toml) as {
      mcp_servers: { 'sprintable-mcp': { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcp_servers['sprintable-mcp'].command).toBe('uvx');
    expect(parsed.mcp_servers['sprintable-mcp'].args).toEqual(['sprintable']);
    expect(parsed.mcp_servers['sprintable-mcp'].env).toEqual({
      SPRINTABLE_API_URL: 'https://backend.example.run.app',
      AGENT_GATEWAY_V2: '1',
      AGENT_API_KEY: 'sk_live_abc123',
    });
  });

  it('http 변형 — url·http_headers(Authorization 포함)가 실 파서로 파싱된다', () => {
    const bundle: McpConfigBundle = {
      mcpServers: {
        'sprintable-mcp': {
          type: 'http',
          url: 'https://mcp.sprintable.ai/mcp',
          headers: { Authorization: 'Bearer sk_live_xyz789' },
        },
      },
    };
    const toml = buildCodexConfigToml(bundle);
    const parsed = parse(toml) as {
      mcp_servers: { 'sprintable-mcp': { url: string; http_headers: Record<string, string> } };
    };
    expect(parsed.mcp_servers['sprintable-mcp'].url).toBe('https://mcp.sprintable.ai/mcp');
    expect(parsed.mcp_servers['sprintable-mcp'].http_headers).toEqual({
      Authorization: 'Bearer sk_live_xyz789',
    });
  });

  it('stdio에서 env가 비어있으면(키 미발급) env 테이블 자체를 생략한다', () => {
    const bundle: McpConfigBundle = {
      mcpServers: {
        'sprintable-mcp': {
          type: 'stdio',
          command: 'uvx',
          args: ['sprintable'],
          env: {},
        },
      },
    };
    const toml = buildCodexConfigToml(bundle);
    expect(toml).not.toContain('.env]');
    const parsed = parse(toml) as { mcp_servers: { 'sprintable-mcp': { command: string } } };
    expect(parsed.mcp_servers['sprintable-mcp'].command).toBe('uvx');
  });

  it('특수문자(따옴표·백슬래시)가 낀 값도 실 파서로 원문 그대로 왕복한다(뮤테이션 대상 — 이스케이프 제거 시 파싱 실패로 RED)', () => {
    const bundle: McpConfigBundle = {
      mcpServers: {
        'sprintable-mcp': {
          type: 'stdio',
          command: 'uvx',
          args: ['sprintable', 'a "quoted" \\ value'],
          env: { AGENT_API_KEY: 'sk_"weird"\\key' },
        },
      },
    };
    const toml = buildCodexConfigToml(bundle);
    const parsed = parse(toml) as {
      mcp_servers: { 'sprintable-mcp': { args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcp_servers['sprintable-mcp'].args).toEqual(['sprintable', 'a "quoted" \\ value']);
    expect(parsed.mcp_servers['sprintable-mcp'].env.AGENT_API_KEY).toBe('sk_"weird"\\key');
  });
});
