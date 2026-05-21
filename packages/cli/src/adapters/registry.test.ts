import { describe, it, expect } from "vitest";
import { getAdapter, SUPPORTED_AGENTS } from "./registry.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("SUPPORTED_AGENTS", () => {
  it("4개 에이전트 타입 지원", () => {
    expect(SUPPORTED_AGENTS).toContain("claude-code");
    expect(SUPPORTED_AGENTS).toContain("cursor");
    expect(SUPPORTED_AGENTS).toContain("windsurf");
    expect(SUPPORTED_AGENTS).toContain("vscode");
    expect(SUPPORTED_AGENTS.length).toBe(4);
  });
});

describe("getAdapter", () => {
  it("claude-code → ~/.mcp.json", () => {
    const a = getAdapter("claude-code");
    expect(a.configPath).toBe(join(homedir(), ".mcp.json"));
  });

  it("cursor → ~/.cursor/mcp.json", () => {
    const a = getAdapter("cursor");
    expect(a.configPath).toBe(join(homedir(), ".cursor", "mcp.json"));
  });

  it("windsurf → ~/.codeium/windsurf/mcp_config.json", () => {
    const a = getAdapter("windsurf");
    expect(a.configPath).toBe(join(homedir(), ".codeium", "windsurf", "mcp_config.json"));
  });

  it("vscode → ~/.vscode/settings.json", () => {
    const a = getAdapter("vscode");
    expect(a.configPath).toBe(join(homedir(), ".vscode", "settings.json"));
  });

  it("알 수 없는 타입 → throw", () => {
    expect(() => getAdapter("unknown")).toThrow("Unknown agent type: unknown");
  });
});
