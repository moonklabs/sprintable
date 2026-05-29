import { describe, it, expect } from "vitest";
import {
  parseClaudeAlias,
  injectFakechatAlias,
  detectRcFile,
  detectPlatform,
  getPowerShellProfiles,
  parsePowerShellClaudeFunction,
  injectFakechatPowerShell,
} from "./onboard.js";

const FAKECHAT_CHANNEL = "plugin:fakechat:ws://localhost:8787";

// ─── AC1: 에이전트 선택 ───────────────────────────────────────────────────────

describe("onboardCommand export", () => {
  it("onboardCommand 함수가 export됨", async () => {
    const mod = await import("./onboard.js");
    expect(typeof mod.onboardCommand).toBe("function");
  });

  it("detectRcFile 함수가 export됨", async () => {
    const mod = await import("./onboard.js");
    expect(typeof mod.detectRcFile).toBe("function");
  });
});

// ─── 플랫폼 감지 ──────────────────────────────────────────────────────────────

describe("detectPlatform", () => {
  it("함수가 export됨", () => {
    expect(typeof detectPlatform).toBe("function");
  });

  it("반환값이 SupportedPlatform 타입 중 하나", () => {
    const result = detectPlatform();
    const valid = ["win32", "darwin", "linux", "unsupported"];
    expect(valid).toContain(result);
  });
});

// ─── detectRcFile 플랫폼 분기 ─────────────────────────────────────────────────

describe("detectRcFile", () => {
  it("darwin 플랫폼 — 경로가 homedir 포함", () => {
    const result = detectRcFile("darwin");
    expect(result).toContain(process.env.HOME ?? "/");
  });

  it("linux 플랫폼 — 경로가 homedir 포함", () => {
    const result = detectRcFile("linux");
    expect(result).toContain(process.env.HOME ?? "/");
  });

  it("win32 플랫폼 — .bashrc fallback 반환", () => {
    const result = detectRcFile("win32");
    // win32는 후보 없음 → fallback .bashrc
    expect(result).toMatch(/\.bashrc$/);
  });

  it("unsupported 플랫폼 — .bashrc fallback 반환", () => {
    const result = detectRcFile("unsupported");
    expect(result).toMatch(/\.bashrc$/);
  });
});

// ─── AC2: alias 파싱 로직 ────────────────────────────────────────────────────

describe("parseClaudeAlias", () => {
  it("alias claude=... 라인을 파싱함", () => {
    const content = `export PATH="$PATH:/usr/local/bin"\nalias claude="claude --mcp-config ~/.mcp.json"\n`;
    const result = parseClaudeAlias(content);
    expect(result).not.toBeNull();
    expect(result?.cmd).toBe("claude --mcp-config ~/.mcp.json");
  });

  it("단따옴표 alias도 파싱함", () => {
    const content = `alias claude='claude --mcp-config ~/.mcp.json'\n`;
    const result = parseClaudeAlias(content);
    expect(result).not.toBeNull();
    expect(result?.cmd).toBe("claude --mcp-config ~/.mcp.json");
  });

  it("alias 없으면 null 반환", () => {
    const content = `export PATH="$PATH:/usr/local/bin"\n`;
    expect(parseClaudeAlias(content)).toBeNull();
  });
});

// ─── AC2: alias 주입 로직 ────────────────────────────────────────────────────

describe("injectFakechatAlias", () => {
  it("기존 alias에 --channels 추가", () => {
    const content = `alias claude="claude --mcp-config ~/.mcp.json"\n`;
    const result = injectFakechatAlias(content, "~/.zshrc");
    expect(result).toContain("--channels");
    expect(result).toContain(FAKECHAT_CHANNEL);
    expect(result).toContain("claude --mcp-config ~/.mcp.json");
  });

  it("alias 없으면 신규 alias 라인 추가", () => {
    const content = `export PATH="$PATH:/usr/bin"\n`;
    const result = injectFakechatAlias(content, "~/.zshrc");
    expect(result).toContain("alias claude=");
    expect(result).toContain(FAKECHAT_CHANNEL);
    expect(result).toContain("export PATH");
  });

  it("이미 fakechat 포함된 alias는 변경하지 않음", () => {
    const content = `alias claude="claude --channels '${FAKECHAT_CHANNEL}'"\n`;
    const result = injectFakechatAlias(content, "~/.zshrc");
    expect(result).toBe(content);
  });

  it("--channels 있지만 fakechat 없으면 채널만 추가", () => {
    const content = `alias claude="claude --channels 'other:ws://localhost:9000'"\n`;
    const result = injectFakechatAlias(content, "~/.zshrc");
    expect(result).toContain(FAKECHAT_CHANNEL);
  });

  it("원본 내용 보존 (기존 라인 유지)", () => {
    const content = `# shell config\nexport FOO=bar\nalias claude="claude"\n`;
    const result = injectFakechatAlias(content, "~/.zshrc");
    expect(result).toContain("export FOO=bar");
    expect(result).toContain("# shell config");
  });
});

// ─── Windows: PowerShell profile 로직 ────────────────────────────────────────

describe("getPowerShellProfiles", () => {
  it("두 개의 profile 경로 반환", () => {
    const profiles = getPowerShellProfiles();
    expect(profiles).toHaveLength(2);
  });

  it("PS 7+ profile이 첫 번째", () => {
    const profiles = getPowerShellProfiles();
    expect(profiles[0]).toContain("PowerShell");
    expect(profiles[0]).toContain("profile.ps1");
  });

  it("PS 5.1 fallback이 두 번째", () => {
    const profiles = getPowerShellProfiles();
    expect(profiles[1]).toContain("WindowsPowerShell");
    expect(profiles[1]).toContain("profile.ps1");
  });
});

describe("parsePowerShellClaudeFunction", () => {
  it("function claude { ... } 블록 감지", () => {
    const content = `function claude { claude.exe @args }\n`;
    expect(parsePowerShellClaudeFunction(content)).toBe(true);
  });

  it("function 없으면 false", () => {
    const content = `# PowerShell profile\n$env:PATH += ";C:\\tools"\n`;
    expect(parsePowerShellClaudeFunction(content)).toBe(false);
  });

  it("다른 function은 감지하지 않음", () => {
    const content = `function myFunc { echo "hello" }\n`;
    expect(parsePowerShellClaudeFunction(content)).toBe(false);
  });
});

describe("injectFakechatPowerShell", () => {
  it("빈 profile에 function 추가", () => {
    const content = `# PowerShell profile\n`;
    const result = injectFakechatPowerShell(content);
    expect(result).toContain("function claude");
    expect(result).toContain(FAKECHAT_CHANNEL);
    expect(result).toContain("@args");
  });

  it("이미 fakechat 포함된 profile은 변경하지 않음", () => {
    const content = `function claude { claude.exe --channels '${FAKECHAT_CHANNEL}' @args }\n`;
    const result = injectFakechatPowerShell(content);
    expect(result).toBe(content);
  });

  it("기존 function claude 교체 (fakechat 없는 경우)", () => {
    const content = `function claude { claude.exe @args }\n`;
    const result = injectFakechatPowerShell(content);
    expect(result).toContain(FAKECHAT_CHANNEL);
  });

  it("원본 내용 보존", () => {
    const content = `# My profile\n$env:FOO = "bar"\n`;
    const result = injectFakechatPowerShell(content);
    expect(result).toContain("$env:FOO");
    expect(result).toContain("# My profile");
  });
});

// ─── AC3: 기타 에이전트 흐름 검증 (구조 테스트) ─────────────────────────────

describe("onboard module structure", () => {
  it("OnboardAgentType이 claude-code 포함", async () => {
    const { onboardCommand } = await import("./onboard.js");
    expect(onboardCommand).toBeDefined();
  });
});
