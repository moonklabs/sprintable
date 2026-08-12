import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeMcpServersFormat, writeMcpSectionFormat } from "./types.js";

// engines floor is node>=20.0.0 — import.meta.dirname needs 20.11+, so derive it the
// portable way instead.
const currentDir = dirname(fileURLToPath(import.meta.url));

// story #2579 — server key ("sprintable-mcp") and the uvx package/console-script name
// ("sprintable", the actual PyPI name) are two different strings this file previously
// conflated: both writers put the server key into `args` too, so `uvx sprintable-mcp`
// looked up a package that doesn't exist on PyPI and stdio registration failed. These
// tests exercise the real writer functions against a real temp file (not a hand-built
// literal standing in for the implementation, story #2965 QA note) so a regression in
// either writer actually fails the test.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sprintable-cli-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeMcpServersFormat — mcpServers 형식", () => {
  it("uvx 패키지명은 sprintable(PyPI 실명), 서버키는 sprintable-mcp(#2577)", () => {
    const configPath = join(dir, ".mcp.json");
    writeMcpServersFormat(configPath, "https://api.sprintable.ai/", "sk_test");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const server = config.mcpServers["sprintable-mcp"];
    expect(server.command).toBe("uvx");
    expect(server.args).toEqual(["sprintable"]);
  });

  it("SSOT(backend agent_onboarding_config.py::_build_stdio_config) 필드와 정합 — AGENT_GATEWAY_V2 누락 없음", () => {
    const configPath = join(dir, ".mcp.json");
    writeMcpServersFormat(configPath, "https://api.sprintable.ai", "sk_test");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const server = config.mcpServers["sprintable-mcp"];
    expect(server.type).toBe("stdio");
    expect(server.env).toEqual({
      SPRINTABLE_API_URL: "https://api.sprintable.ai",
      AGENT_GATEWAY_V2: "1",
      AGENT_API_KEY: "sk_test",
    });
  });

  it("기존 mcpServers 항목은 보존한다", () => {
    const configPath = join(dir, ".mcp.json");
    writeMcpServersFormat(configPath, "https://api.sprintable.ai", "sk_first");
    // 기존 파일에 다른 서버가 있다고 가정하고 그 위에 다시 쓴다
    const before = JSON.parse(readFileSync(configPath, "utf-8"));
    before.mcpServers.other = { command: "other" };
    writeFileSync(configPath, JSON.stringify(before, null, 2) + "\n");

    writeMcpServersFormat(configPath, "https://api.sprintable.ai", "sk_second");
    const after = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(after.mcpServers).toHaveProperty("other");
    expect(after.mcpServers["sprintable-mcp"].env.AGENT_API_KEY).toBe("sk_second");
  });
});

describe("writeMcpSectionFormat — VS Code mcp.servers 형식", () => {
  it("uvx 패키지명은 sprintable, 서버키는 sprintable-mcp", () => {
    const configPath = join(dir, "settings.json");
    writeMcpSectionFormat(configPath, "https://api.sprintable.ai", "sk_test");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const server = config.mcp.servers["sprintable-mcp"];
    expect(server.args).toEqual(["sprintable"]);
    expect(server.env.AGENT_GATEWAY_V2).toBe("1");
  });
});

// story #2579 AC3 — 이 파일이 SSOT(backend)에서 발산해도 잡을 방법이 없으면 이 버그가
// 재발한다. TS 쪽만 정확해도 backend가 나중에 uvx 패키지명을 바꾸면 다시 어긋난다 —
// backend 소스 리터럴을 직접 읽어 여기서 하드코딩한 기대값과 대조한다(빌드 산출물이 아닌
// 소스라 배포 여부와 무관하게 항상 최신).
describe("backend SSOT와 uvx 패키지명 일치(회귀가드)", () => {
  it("backend/app/services/agent_onboarding_config.py의 _build_stdio_config args와 일치", () => {
    const backendPath = join(
      currentDir, "..", "..", "..", "..",
      "backend", "app", "services", "agent_onboarding_config.py",
    );
    const source = readFileSync(backendPath, "utf-8");
    // _build_stdio_config() 안의 정확히 이 리터럴만 매치 — 다른 args:[...] 오탐 방지.
    expect(source).toContain('"args": ["sprintable"],  # PyPI package/console-script name');
  });
});
