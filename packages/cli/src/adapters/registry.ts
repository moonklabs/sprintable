import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "./types.js";
import { readJsonFile, writeMcpServersFormat, writeMcpSectionFormat } from "./types.js";

function makeAdapter(
  agentType: string,
  configPath: string,
  mode: "mcpServers" | "mcpSection",
): AgentAdapter {
  return {
    agentType,
    configPath,
    readConfig: () => readJsonFile(configPath),
    writeConfig: (apiUrl, apiKey) =>
      mode === "mcpServers"
        ? writeMcpServersFormat(configPath, apiUrl, apiKey)
        : writeMcpSectionFormat(configPath, apiUrl, apiKey),
    hasExistingServer: () => {
      const cfg = readJsonFile(configPath);
      if (mode === "mcpServers") {
        return !!(cfg.mcpServers as Record<string, unknown> | undefined)?.["sprintable"];
      }
      return !!(
        (cfg.mcp as Record<string, unknown> | undefined)?.servers as
          | Record<string, unknown>
          | undefined
      )?.["sprintable"];
    },
  };
}

const ADAPTERS: Record<string, AgentAdapter> = {
  "claude-code": makeAdapter(
    "claude-code",
    join(homedir(), ".mcp.json"),
    "mcpServers",
  ),
  cursor: makeAdapter(
    "cursor",
    join(homedir(), ".cursor", "mcp.json"),
    "mcpServers",
  ),
  windsurf: makeAdapter(
    "windsurf",
    join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    "mcpServers",
  ),
  vscode: makeAdapter(
    "vscode",
    join(homedir(), ".vscode", "settings.json"),
    "mcpSection",
  ),
};

export function getAdapter(agentType: string): AgentAdapter {
  const adapter = ADAPTERS[agentType];
  if (!adapter) throw new Error(`Unknown agent type: ${agentType}`);
  return adapter;
}

export const SUPPORTED_AGENTS = Object.keys(ADAPTERS);
