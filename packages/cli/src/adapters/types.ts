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
  servers["sprintable"] = {
    command: "uvx",
    args: ["sprintable-mcp"],
    env: {
      SPRINTABLE_API_URL: apiUrl.replace(/\/$/, ""),
      AGENT_API_KEY: apiKey,
    },
  };
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
  servers["sprintable"] = {
    command: "uvx",
    args: ["sprintable-mcp"],
    env: {
      SPRINTABLE_API_URL: apiUrl.replace(/\/$/, ""),
      AGENT_API_KEY: apiKey,
    },
  };
  mcp.servers = servers;
  config.mcp = mcp;
  writeJsonFile(configPath, config);
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
