#!/usr/bin/env node
import { Command, Option } from "commander";
import { connectCommand } from "./commands/connect.js";
import { onboardCommand } from "./commands/onboard.js";
import { healthCheckCommand } from "./commands/health-check.js";
import { SUPPORTED_AGENTS } from "./adapters/registry.js";

const program = new Command();

program
  .name("sprintable")
  .description("Sprintable CLI — AI 에이전트 MCP 연결 도구")
  .version("0.1.0");

program
  .command("connect")
  .description("Sprintable MCP 서버를 에이전트 설정 파일에 등록합니다")
  .addOption(
    new Option("--agent <type>", "에이전트 타입 (기본: claude-code)")
      .choices(SUPPORTED_AGENTS)
      .default("claude-code")
  )
  .action(async (opts: { agent?: string }) => {
    try {
      await connectCommand({ agent: opts.agent as "claude-code" | "cursor" | "windsurf" });
    } catch (err) {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log("\n취소되었습니다.");
        process.exit(0);
      }
      throw err;
    }
  });

program
  .command("onboard")
  .description("에이전트 종류별 Sprintable 온보딩 가이드")
  .action(async () => {
    try {
      await onboardCommand();
    } catch (err) {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log("\n취소되었습니다.");
        process.exit(0);
      }
      throw err;
    }
  });

program
  .command("health-check")
  .description("E2E 통신 경로 전체 검증 (메시지→SSE→reply→확인)")
  .action(async () => {
    try {
      await healthCheckCommand();
    } catch (err) {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log("\n취소되었습니다.");
        process.exit(0);
      }
      throw err;
    }
  });

program.parse();
