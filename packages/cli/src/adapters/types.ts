import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentAdapter {
  readonly agentType: string;
  readonly configPath: string;
  readConfig(): Record<string, unknown>;
  writeConfig(apiUrl: string, apiKey: string): void;
  hasExistingServer(): boolean;
}

/** mcpServers 형식 (Claude Code / Cursor / Windsurf 공통) */
export function writeMcpServersFormat(
  configPath: string,
  apiUrl: string,
  apiKey: string,
): void {
  const config = readJsonFile(configPath);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers["sprintable-mcp"] = buildStdioServerEntry(apiUrl, apiKey);
  config.mcpServers = servers;
  writeJsonFile(configPath, config);
}

/** VS Code settings.json mcp.servers 형식 */
export function writeMcpSectionFormat(
  configPath: string,
  apiUrl: string,
  apiKey: string,
): void {
  const config = readJsonFile(configPath);
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  const servers = (mcp.servers ?? {}) as Record<string, unknown>;
  servers["sprintable-mcp"] = buildStdioServerEntry(apiUrl, apiKey);
  mcp.servers = servers;
  config.mcp = mcp;
  writeJsonFile(configPath, config);
}

/**
 * stdio MCP server entry — single source shared by both writer formats above.
 *
 * story #2579: server key ("sprintable-mcp", #2577 rename) and the `uvx` package/
 * console-script name ("sprintable", the actual PyPI name) are two different strings
 * that this file previously conflated — both writers passed the server key into
 * `args` too, so `uvx sprintable-mcp` looked up a package that doesn't exist on PyPI
 * (only `sprintable` is published) and stdio registration failed outright. Also
 * brings this generator to parity with the backend SSOT
 * (`backend/app/services/agent_onboarding_config.py::_build_stdio_config`) which this
 * had silently drifted from: `AGENT_GATEWAY_V2` was missing (sse_bridge falls back to
 * the legacy `/api/v2/events/stream` path without it — tools list fine, messages never
 * arrive) and `type: "stdio"` was omitted.
 */
function buildStdioServerEntry(apiUrl: string, apiKey: string): Record<string, unknown> {
  return {
    type: "stdio",
    command: "uvx",
    args: ["sprintable"],
    env: {
      SPRINTABLE_API_URL: apiUrl.replace(/\/$/, ""),
      AGENT_GATEWAY_V2: "1",
      AGENT_API_KEY: apiKey,
    },
  };
}

export function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeJsonFile(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
