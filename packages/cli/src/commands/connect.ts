import input from "@inquirer/input";
import password from "@inquirer/password";
import confirm from "@inquirer/confirm";
import select from "@inquirer/select";
import { getAdapter, SUPPORTED_AGENTS } from "../adapters/registry.js";
import { ping, getMe, getProjects, listTeamMembers, createTeamMember } from "../api.js";

export type AgentType = "claude-code" | "cursor" | "windsurf" | "vscode";

export interface ConnectOptions {
  agent?: AgentType;
}

export async function connectCommand(opts: ConnectOptions = {}): Promise<void> {
  const agent = (opts.agent ?? "claude-code") as string;
  const adapter = getAdapter(agent);

  console.log("\n🔗 Sprintable MCP 연결 설정\n");
  console.log(`   대상 에이전트: ${agent}  (설정 파일: ${adapter.configPath})\n`);

  // ── 1. API URL + Admin API Key 입력 ─────────────────────────────────────
  const apiUrl = await input({
    message: "Sprintable API URL",
    default: "https://app.sprintable.ai",
    validate: (v) => (v.startsWith("http") ? true : "http(s):// 로 시작해야 합니다"),
  });

  const adminKey = await password({
    message: "Admin API Key (팀 관리자 권한)",
    validate: (v) => (v.trim().length > 0 ? true : "API Key를 입력하세요"),
  });

  // ── 2. 연결 확인 ─────────────────────────────────────────────────────────
  process.stdout.write("⏳ 연결 확인 중...");
  const ok = await ping(apiUrl, adminKey.trim());
  if (!ok) {
    process.stdout.write(" ❌\n");
    console.error("\n연결 실패: API URL 또는 API Key를 확인하세요.");
    process.exit(1);
  }
  process.stdout.write(" ✅\n");

  // ── 3. org_id 조회 ───────────────────────────────────────────────────────
  const me = await getMe(apiUrl, adminKey.trim());
  if (!me?.org_id) {
    console.error("\norg_id 조회 실패: admin API key 권한을 확인하세요.");
    process.exit(1);
  }

  // ── 4. 프로젝트 선택 ─────────────────────────────────────────────────────
  let projectId: string;
  try {
    const projects = await getProjects(apiUrl, adminKey.trim());
    if (projects.length === 0) {
      console.error("\n프로젝트가 없습니다. Sprintable에서 프로젝트를 먼저 생성하세요.");
      process.exit(1);
    }
    if (projects.length === 1) {
      projectId = projects[0].id;
      console.log(`   프로젝트: ${projects[0].name}`);
    } else {
      projectId = await select({
        message: "프로젝트 선택",
        choices: projects.map((p) => ({ name: p.name, value: p.id })),
      });
    }
  } catch {
    projectId = await input({
      message: "Project ID (UUID)",
      validate: (v) => (v.trim().length > 0 ? true : "Project ID를 입력하세요"),
    });
  }

  // ── 5. 에이전트 이름 입력 ─────────────────────────────────────────────────
  const agentName = await input({
    message: "에이전트 이름",
    default: "My Agent",
    validate: (v) => (v.trim().length > 0 ? true : "이름을 입력하세요"),
  });

  // ── 6. AC6: 이미 등록된 member 확인 ─────────────────────────────────────
  let finalApiKey: string;
  try {
    const existing = await listTeamMembers(apiUrl, adminKey.trim(), projectId);
    const dup = existing.find(
      (m) => m.name === agentName.trim() && m.type === "agent",
    );
    if (dup) {
      const overwrite = await confirm({
        message: `'${agentName}' 에이전트가 이미 존재합니다. 새 API key를 발급하시겠습니까?`,
        default: false,
      });
      if (!overwrite) {
        console.log("\n기존 에이전트를 사용합니다. API key를 직접 입력하세요.");
        finalApiKey = await password({
          message: "기존 Agent API Key",
          validate: (v) => (v.trim().length > 0 ? true : "API Key를 입력하세요"),
        });
        adapter.writeConfig(apiUrl, finalApiKey.trim());
        _printSuccess(adapter.configPath, agent);
        return;
      }
    }
  } catch {
    // member 목록 조회 실패 시 계속 진행
  }

  // ── 7. team-member 생성 + API key 발급 ───────────────────────────────────
  process.stdout.write("⏳ 에이전트 등록 중...");
  try {
    const member = await createTeamMember(apiUrl, adminKey.trim(), {
      project_id: projectId,
      org_id: me.org_id,
      type: "agent",
      name: agentName.trim(),
    });
    process.stdout.write(" ✅\n");

    if (!member.api_key) {
      console.error("\nAPI key 발급 실패 — 수동으로 Sprintable에서 확인하세요.");
      process.exit(1);
    }
    finalApiKey = member.api_key;
  } catch (err) {
    process.stdout.write(" ❌\n");
    console.error(`\n에이전트 등록 실패: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── 8. 설정 파일 기록 ────────────────────────────────────────────────────
  if (adapter.hasExistingServer()) {
    const overwrite = await confirm({
      message: `${adapter.configPath}에 이미 'sprintable' 서버가 있습니다. 덮어쓰시겠습니까?`,
      default: true,
    });
    if (!overwrite) {
      console.log("취소되었습니다.");
      return;
    }
  }

  adapter.writeConfig(apiUrl, finalApiKey);
  _printSuccess(adapter.configPath, agent);
}

function _printSuccess(configPath: string, agent: string): void {
  console.log(`\n✅ ${configPath}에 'sprintable' 서버가 추가되었습니다.`);
  console.log("\n다음 단계:");
  const clientName =
    agent === "claude-code" ? "Claude Code"
    : agent === "cursor" ? "Cursor"
    : agent === "vscode" ? "VS Code"
    : "Windsurf";
  console.log(`  1. ${clientName}를 재시작하세요.`);
  console.log(`  2. 'sprintable_ping' 도구가 보이면 연결 완료입니다.\n`);
}

// legacy exports for backward compat
export { readJsonFile as readMcpConfig, writeJsonFile as writeMcpConfig } from "../adapters/types.js";
