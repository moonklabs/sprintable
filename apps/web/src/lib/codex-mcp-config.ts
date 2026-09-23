/**
 * story #4180(E-PROD-ESC·온보딩) — Codex CLI는 `.mcp.json`을 읽지 않는다(TOML, `config.toml`의
 * `[mcp_servers.<name>]` 테이블). 공식 스키마(2026-09-23 확인, developers.openai.com/codex/mcp →
 * learn.chatgpt.com/docs/extend/mcp?surface=cli): stdio는 `command`/`args`/`env`, streamable-http는
 * `url`/`http_headers`(정적 헤더 키-값) — 우리 `McpServerConfig`(recruit.ts)가 이미 담은 값을
 * TOML 문법으로만 재직렬화한다(값 자체는 BE `agent_onboarding_config.py` SSOT 그대로, 새로 안 만듦).
 */
import type { McpConfigBundle } from '@/services/recruit';

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

function tomlKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : tomlString(key);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * `McpConfigBundle`(JSON, `.mcp.json` 아티팩트)을 Codex `config.toml`의 `[mcp_servers.<name>]`
 * 조각으로 재직렬화. stdio는 `command`/`args`/`[mcp_servers.<name>.env]`, http는 `url`/
 * `http_headers`(정적 헤더 — 우리 값은 이미 `Authorization: Bearer <key>` 리터럴이라 `.mcp.json`의
 * `headers`와 동일 신뢰 모델, `bearer_token_env_var`류 간접 참조로 바꾸지 않는다 — 다른 런타임과
 * 노출 방식을 다르게 하지 않는다는 원칙).
 */
export function buildCodexConfigToml(bundle: McpConfigBundle): string {
  const [serverName, server] = Object.entries(bundle.mcpServers)[0]!;
  const table = tomlKey(serverName);
  const lines: string[] = [`[mcp_servers.${table}]`];

  if (server.type === 'http') {
    lines.push(`url = ${tomlString(server.url ?? '')}`);
    // 유나 design(PR 4542) — 인라인 테이블이면 Bearer 키 줄이 카드 폭을 넘는다. env와 같은
    // 하위 테이블 형식(파서상 같은 객체)으로 줄을 짧게.
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${table}.http_headers]`);
      for (const [k, v] of Object.entries(server.headers)) {
        lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
      }
    }
  } else {
    lines.push(`command = ${tomlString(server.command ?? '')}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = ${tomlStringArray(server.args)}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${table}.env]`);
      for (const [k, v] of Object.entries(server.env)) {
        lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
