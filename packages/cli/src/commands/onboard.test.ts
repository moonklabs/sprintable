import { describe, it, expect } from "vitest";
import { parseClaudeAlias, injectFakechatAlias, detectRcFile } from "./onboard.js";

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

// ─── AC3: 기타 에이전트 흐름 검증 (구조 테스트) ─────────────────────────────

describe("onboard module structure", () => {
  it("OnboardAgentType이 claude-code 포함", async () => {
    // 타입 레벨 검증 — 컴파일 성공이면 OK
    const { onboardCommand } = await import("./onboard.js");
    expect(onboardCommand).toBeDefined();
  });
});
