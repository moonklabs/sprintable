/**
 * S-COMM-08: sprintable onboard — 에이전트 온보딩 가이드 CLI
 *
 * AC1: 에이전트 종류 선택 (Claude Code / Hermes / Codex / OpenClaw / 기타)
 * AC2: Claude Code → fakechat 플러그인 설치 안내 + shell/PS 자동 설정
 *   - win32:  PowerShell $PROFILE function 주입
 *   - darwin: .zshrc alias 주입
 *   - linux:  .bashrc / .zshrc alias 주입
 *   - 기타:   수동 설정 가이드 출력
 * AC3: 기타 에이전트 → API Key + SSE inbox URL + 구독 방법 안내
 */
import select from "@inquirer/select";
import confirm from "@inquirer/confirm";
import input from "@inquirer/input";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OnboardAgentType =
  | "claude-code"
  | "hermes"
  | "codex"
  | "openclaw"
  | "other";

export type SupportedPlatform = "win32" | "darwin" | "linux" | "unsupported";

const FAKECHAT_CHANNEL = "plugin:fakechat:ws://localhost:8787";
const FAKECHAT_PLUGIN = "@sprintable/fakechat";

// ─── 플랫폼 감지 ──────────────────────────────────────────────────────────────

export function detectPlatform(): SupportedPlatform {
  const p = process.platform;
  if (p === "win32") return "win32";
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unsupported";
}

// ─── Unix: RC 파일 + alias 로직 ───────────────────────────────────────────────

const UNIX_RC_FILES: Record<SupportedPlatform, string[]> = {
  darwin: [
    join(homedir(), ".zshrc"),
    join(homedir(), ".bash_profile"),
    join(homedir(), ".bashrc"),
  ],
  linux: [
    join(homedir(), ".bashrc"),
    join(homedir(), ".zshrc"),
    join(homedir(), ".bash_profile"),
  ],
  win32: [],
  unsupported: [],
};

/** 첫 번째 존재하는 RC 파일 반환. 없으면 플랫폼 기본값 (신규 생성 대상). */
export function detectRcFile(platform: SupportedPlatform = detectPlatform()): string {
  const candidates = UNIX_RC_FILES[platform] ?? [];
  return candidates.find((f) => existsSync(f)) ?? candidates[0] ?? join(homedir(), ".bashrc");
}

/** RC 파일에서 alias claude=... 라인과 기존 커맨드 추출 */
export function parseClaudeAlias(
  content: string,
): { line: string; cmd: string } | null {
  const match = content.match(/^(alias\s+claude\s*=\s*["'](.*)["'])\s*$/m);
  if (!match) return null;
  return { line: match[1], cmd: match[2] };
}

/** RC 파일 내용에 fakechat 채널 추가 후 반환. 이미 있으면 원본 반환. */
export function injectFakechatAlias(content: string, _rcFile: string): string {
  const existing = parseClaudeAlias(content);

  if (existing) {
    if (existing.cmd.includes("fakechat")) return content;
    if (existing.cmd.includes("--channels")) {
      const updated = `${existing.cmd} ${FAKECHAT_CHANNEL}`;
      return content.replace(existing.line, `alias claude="${updated}"`);
    }
    const updated = `${existing.cmd} --channels "${FAKECHAT_CHANNEL}"`;
    return content.replace(existing.line, `alias claude="${updated}"`);
  }

  const newAlias = `\n# Added by sprintable onboard\nalias claude="claude --channels '${FAKECHAT_CHANNEL}'"\n`;
  return content + newAlias;
}

// ─── Windows: PowerShell profile 로직 ────────────────────────────────────────

/** PowerShell $PROFILE 경로 후보 목록 (PS 7+ 우선, 5.1 fallback) */
export function getPowerShellProfiles(): string[] {
  const home = homedir();
  return [
    join(home, "Documents", "PowerShell", "profile.ps1"),           // PS 7+
    join(home, "Documents", "WindowsPowerShell", "profile.ps1"),     // PS 5.1
  ];
}

export function detectPowerShellProfile(): string {
  return getPowerShellProfiles().find((f) => existsSync(f)) ?? getPowerShellProfiles()[0];
}

/** PowerShell profile에서 function claude { ... } 블록 탐지 */
export function parsePowerShellClaudeFunction(content: string): boolean {
  return /^function\s+claude\s*\{/m.test(content);
}

/** PowerShell profile에 fakechat 채널 function 주입 */
export function injectFakechatPowerShell(content: string): string {
  if (parsePowerShellClaudeFunction(content)) {
    if (content.includes("fakechat")) return content;
    // 기존 function 교체: --channels 추가
    return content.replace(
      /^(function\s+claude\s*\{[^}]*)\}/m,
      `function claude { claude.exe --channels '${FAKECHAT_CHANNEL}' @args }`,
    );
  }
  const newFn = `\n# Added by sprintable onboard\nfunction claude { claude.exe --channels '${FAKECHAT_CHANNEL}' @args }\n`;
  return content + newFn;
}

// ─── AC2: Claude Code 온보딩 — 플랫폼 분기 ───────────────────────────────────

async function _applyUnixAlias(platform: SupportedPlatform): Promise<void> {
  const rcFile = detectRcFile(platform);
  const content = existsSync(rcFile) ? readFileSync(rcFile, "utf-8") : "";
  const existing = parseClaudeAlias(content);

  if (existing) {
    console.log(`   기존 alias 발견 (${rcFile}):`);
    console.log(`   ${existing.line}\n`);
    if (existing.cmd.includes("fakechat")) {
      console.log("   ✅ 이미 fakechat 채널이 포함되어 있습니다.\n");
      return;
    }
  } else {
    console.log(`   ${rcFile}에서 alias claude=... 를 찾지 못했습니다.\n`);
  }

  const updated = injectFakechatAlias(content, rcFile);
  const newAlias = parseClaudeAlias(updated);
  const preview = newAlias?.line ?? `alias claude="claude --channels '${FAKECHAT_CHANNEL}'"`;
  console.log("   적용될 alias:");
  console.log(`   ${preview}\n`);

  const ok = await confirm({
    message: `${rcFile}에 자동으로 적용할까요?`,
    default: true,
  });
  if (ok) {
    writeFileSync(rcFile, updated, "utf-8");
    console.log(`\n   ✅ ${rcFile} 업데이트 완료.`);
    console.log("   터미널 재시작 또는:\n");
    console.log(`   $ source ${rcFile}\n`);
  } else {
    console.log(`\n   수동으로 ${rcFile}에 다음을 추가하세요:\n`);
    console.log(`   ${preview}\n`);
  }
}

async function _applyWindowsAlias(): Promise<void> {
  const psProfile = detectPowerShellProfile();
  const content = existsSync(psProfile) ? readFileSync(psProfile, "utf-8") : "";

  if (parsePowerShellClaudeFunction(content) && content.includes("fakechat")) {
    console.log("   ✅ PowerShell profile에 이미 fakechat 채널이 포함되어 있습니다.\n");
    return;
  }

  const fnLine = `function claude { claude.exe --channels '${FAKECHAT_CHANNEL}' @args }`;
  console.log(`   PowerShell profile: ${psProfile}`);
  console.log("\n   추가될 function:");
  console.log(`   ${fnLine}\n`);

  const ok = await confirm({
    message: `${psProfile}에 자동으로 추가할까요?`,
    default: true,
  });
  if (ok) {
    const updated = injectFakechatPowerShell(content);
    writeFileSync(psProfile, updated, "utf-8");
    console.log(`\n   ✅ ${psProfile} 업데이트 완료.`);
    console.log("   PowerShell을 재시작하거나 다음을 실행하세요:\n");
    console.log(`   . $PROFILE\n`);
  } else {
    console.log(`\n   수동으로 ${psProfile}에 다음을 추가하세요:\n`);
    console.log(`   ${fnLine}\n`);
  }
}

async function onboardClaudeCode(): Promise<void> {
  const platform = detectPlatform();
  console.log("\n── Claude Code 온보딩 ──────────────────────────────────────\n");

  // Step 1: fakechat 플러그인 설치 안내
  console.log("1️⃣  fakechat 플러그인 설치\n");
  console.log(`   Claude Code 플러그인 마켓에서 '${FAKECHAT_PLUGIN}'을 설치하세요:`);
  console.log(`\n   $ claude plugin install ${FAKECHAT_PLUGIN}\n`);

  const installed = await confirm({
    message: "fakechat 플러그인 설치가 완료되었나요?",
    default: true,
  });
  if (!installed) {
    console.log("\n설치 후 다시 실행해 주세요: sprintable onboard");
    return;
  }

  // Step 2: alias / function 설정
  console.log("\n2️⃣  채널 alias 설정\n");

  if (platform === "win32") {
    await _applyWindowsAlias();
  } else if (platform === "darwin" || platform === "linux") {
    await _applyUnixAlias(platform);
  } else {
    console.log("   지원하지 않는 플랫폼입니다. 수동으로 설정하세요:\n");
    console.log(`   alias claude="claude --channels '${FAKECHAT_CHANNEL}'"\n`);
    console.log("   shell 설정 파일(~/.bashrc, ~/.zshrc 등)에 위 라인을 추가하세요.\n");
  }

  // Step 3: 채널 확인
  console.log("3️⃣  연결 확인\n");
  console.log("   Claude Code를 재시작한 뒤 등록된 채널 목록 확인:");
  console.log("\n   $ claude --channels\n");
  console.log("   fakechat 채널이 보이면 온보딩 완료입니다. 🎉\n");
}

// ─── AC3: 기타 에이전트 온보딩 ────────────────────────────────────────────────

async function onboardOther(agentLabel: string): Promise<void> {
  console.log(`\n── ${agentLabel} 온보딩 ────────────────────────────────────────\n`);

  console.log("1️⃣  Agent API Key 확인\n");
  console.log("   아직 발급받지 않았다면 먼저 connect 명령어를 실행하세요:");
  console.log("\n   $ sprintable connect\n");

  const apiKey = await input({
    message: "Agent API Key (sk_live_...)",
    validate: (v) => (v.trim().length > 0 ? true : "API Key를 입력하세요"),
  });

  const apiUrl = await input({
    message: "Sprintable API URL",
    default: "https://app.sprintable.ai",
    validate: (v) => (v.startsWith("http") ? true : "http(s)://로 시작해야 합니다"),
  });

  const base = apiUrl.replace(/\/$/, "");

  console.log("\n2️⃣  SSE inbox 구독\n");
  console.log("   에이전트 ID 조회:");
  console.log(`\n   $ curl -H "x-agent-api-key: ${apiKey.trim()}" ${base}/api/v2/auth/me\n`);
  console.log("   이벤트 스트림 구독 (SSE):");
  console.log(`\n   $ curl -N -H "x-agent-api-key: ${apiKey.trim()}" \\`);
  console.log(`       "${base}/api/v2/events/stream?recipient_id=<AGENT_ID>"\n`);

  console.log("3️⃣  외부 서비스 → 에이전트 inbox 전송\n");
  console.log(`   $ curl -X POST ${base}/api/v2/agent-inbox/<AGENT_ID>/webhook \\`);
  console.log(`       -H "Content-Type: application/json" \\`);
  console.log(`       -d '{"event_type":"your_event","data":"payload"}'\n`);

  console.log("4️⃣  Node.js 구독 예시\n");
  console.log(`   import { EventSource } from "eventsource";`);
  console.log(`   const es = new EventSource(\`${base}/api/v2/events/stream?recipient_id=<AGENT_ID>\`, {`);
  console.log(`     headers: { "x-agent-api-key": "${apiKey.trim().substring(0, 8)}..." },`);
  console.log(`   });`);
  console.log(`   es.onmessage = (e) => console.log(JSON.parse(e.data));\n`);

  console.log("   온보딩 완료! 도움이 필요하면: https://docs.sprintable.ai 🎉\n");
}

// ─── Hermes webhook route preset 온보딩 ──────────────────────────────────────

async function onboardHermes(): Promise<void> {
  console.log("\n── Hermes 웹훅 라우터 온보딩 ─────────────────────────────────────\n");

  const agentId = await input({
    message: "내 Agent ID (team_member UUID)",
    validate: (v) => (v.trim().length > 0 ? true : "Agent ID를 입력하세요"),
  });

  const webhookSecret = await input({
    message: "Webhook Secret (Settings → Webhooks → Secret)",
    validate: (v) => (v.trim().length > 0 ? true : "Webhook Secret을 입력하세요"),
  });

  const id = agentId.trim();
  const secret = webhookSecret.trim();

  console.log("\n1️⃣  Webhook 등록\n");
  console.log("   Sprintable Settings → Webhooks → Add Config");
  console.log("   events: [\"conversation.message_created\"]");
  console.log(`   secret: ${secret.substring(0, 4)}...(위 입력값)\n`);

  console.log("2️⃣  인바운드 payload 구조 (conversation_webhook.py 기준)\n");
  console.log("   {");
  console.log('     "event_type": "conversation.message_created",');
  console.log('     "message_id": "<uuid>",');
  console.log('     "conversation_id": "<uuid>",      // {conversation_id}');
  console.log('     "sender_id": "<uuid | null>",     // {sender_id}');
  console.log('     "thread_id": "<uuid | null>",');
  console.log('     "created_at": "<ISO8601>",');
  console.log('     "mentioned_ids": ["<uuid>", ...],');
  console.log('     "content": "<preview>"            // 전문은 list_chat_messages로 조회');
  console.log("   }");
  console.log("   서명 헤더: X-Hub-Signature-256: sha256=<HMAC-SHA256 hex>\n");

  console.log("3️⃣  Route 처리 보일러플레이트 (Python)\n");
  console.log("   import hashlib, hmac, json");
  console.log("   from fastapi import FastAPI, Request, HTTPException\n");
  console.log(`   MY_AGENT_ID = "${id}"`);
  console.log(`   WEBHOOK_SECRET = "${secret.substring(0, 4)}..."\n`);
  console.log("   @app.post('/webhook')");
  console.log("   async def handle(request: Request):");
  console.log("       raw = await request.body()");
  console.log("       sig = request.headers.get('X-Hub-Signature-256')");
  console.log("       expected = 'sha256=' + hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()");
  console.log("       if not hmac.compare_digest(expected, sig or ''):");
  console.log("           raise HTTPException(401)");
  console.log("       payload = json.loads(raw)");
  console.log("       __raw__ = json.dumps(payload)              # {__raw__}: LLM prompt 주입용");
  console.log("       conversation_id = payload['conversation_id']");
  console.log("       sender_id = payload.get('sender_id')");
  console.log("       # self-loop guard (AC2)");
  console.log("       if sender_id == MY_AGENT_ID:");
  console.log("           return {'status': 'ignored'}");
  console.log("       # MCP: sprintable_send_chat_message(thread_id=conversation_id, content=...)");
  console.log("       return {'status': 'ok'}\n");

  console.log("4️⃣  MCP tool 참조\n");
  console.log("   답신: sprintable_send_chat_message(thread_id=<conversation_id>, content=...)");
  console.log("   전문: sprintable_list_chat_messages(thread_id=<conversation_id>)\n");

  console.log("   전체 템플릿: docs/hermes-webhook-route-preset.md 🎉\n");
}

// ─── AC1: 에이전트 선택 진입점 ────────────────────────────────────────────────

export async function onboardCommand(): Promise<void> {
  console.log("\n🚀 Sprintable 에이전트 온보딩\n");

  const agentType = await select<OnboardAgentType>({
    message: "에이전트 종류를 선택하세요",
    choices: [
      { name: "Claude Code", value: "claude-code" },
      { name: "Hermes", value: "hermes" },
      { name: "Codex", value: "codex" },
      { name: "OpenClaw", value: "openclaw" },
      { name: "기타 (API / SSE 직접 구독)", value: "other" },
    ],
  });

  if (agentType === "claude-code") {
    await onboardClaudeCode();
  } else if (agentType === "hermes") {
    await onboardHermes();
  } else {
    const labelMap: Record<string, string> = {
      codex: "Codex",
      openclaw: "OpenClaw",
      other: "기타 에이전트",
    };
    await onboardOther(labelMap[agentType] ?? agentType);
  }
}
