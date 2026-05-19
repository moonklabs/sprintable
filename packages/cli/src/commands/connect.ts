import input from "@inquirer/input";
import password from "@inquirer/password";
import confirm from "@inquirer/confirm";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER_NAME = "sprintable";

type AgentType = "claude-code" | "cursor" | "windsurf";

function getMcpConfigPath(agent: AgentType): string {
  const home = homedir();
  switch (agent) {
    case "claude-code":
      return join(home, ".mcp.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
  }
}

async function pingApi(apiUrl: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v2/ping`, {
      headers: { Authorization: `Bearer ${apiKey}`, "x-agent-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function readMcpConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeMcpConfig(configPath: string, apiUrl: string, apiKey: string): void {
  const config = readMcpConfig(configPath);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers[SERVER_NAME] = {
    command: "uvx",
    args: ["sprintable-mcp"],
    env: {
      SPRINTABLE_API_URL: apiUrl.replace(/\/$/, ""),
      AGENT_API_KEY: apiKey,
    },
  };
  config.mcpServers = servers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export interface ConnectOptions {
  agent?: AgentType;
}

export async function connectCommand(opts: ConnectOptions = {}): Promise<void> {
  const agent = opts.agent ?? "claude-code";
  const configPath = getMcpConfigPath(agent);
  console.log("\n🔗 Sprintable MCP 연결 설정\n");
  console.log(`   대상 에이전트: ${agent}  (설정 파일: ${configPath})\n`);

  const apiUrl = await input({
    message: "Sprintable API URL",
    default: "https://api.sprintable.ai",
    validate: (v) => (v.startsWith("http") ? true : "http(s):// 로 시작해야 합니다"),
  });

  const apiKey = await password({
    message: "Agent API Key",
    validate: (v) => (v.trim().length > 0 ? true : "API Key를 입력하세요"),
  });

  process.stdout.write("⏳ 연결 확인 중...");
  const ok = await pingApi(apiUrl, apiKey.trim());
  if (!ok) {
    process.stdout.write(" ❌\n");
    console.error("\n연결 실패: API URL 또는 API Key를 확인하세요.");
    process.exit(1);
  }
  process.stdout.write(" ✅\n");

  // 기존 설정 덮어쓰기 확인
  const existing = readMcpConfig(configPath);
  const existingServers = existing.mcpServers as Record<string, unknown> | undefined;
  if (existingServers?.[SERVER_NAME]) {
    const overwrite = await confirm({
      message: `${configPath}에 이미 '${SERVER_NAME}' 서버가 있습니다. 덮어쓰시겠습니까?`,
      default: true,
    });
    if (!overwrite) {
      console.log("취소되었습니다.");
      return;
    }
  }

  writeMcpConfig(configPath, apiUrl, apiKey.trim());

  console.log(`\n✅ ${configPath}에 '${SERVER_NAME}' 서버가 추가되었습니다.`);
  console.log("\n다음 단계:");
  console.log(`  1. ${agent === "claude-code" ? "Claude Code" : agent}를 재시작하세요.`);
  console.log(`  2. 'sprintable_ping' 도구가 보이면 연결 완료입니다.\n`);
}
