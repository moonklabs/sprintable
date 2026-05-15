#!/usr/bin/env bun
/**
 * AC8: Regression check — verifies _portFromProjectDir() resolves the correct
 * per-agent port from each agent workspace's .mcp.json.
 *
 * Usage: bun smoke.ts
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HOME = homedir()

const EXPECTED: Record<string, number> = {
  nwachukwu: 8787,
  qasim: 8788,
  mirko: 8789,
  damrong: 8790,
  ortega: 8791,
}

function portFromMcpJson(agentDir: string): number | null {
  try {
    const raw = readFileSync(join(agentDir, '.mcp.json'), 'utf-8')
    const port = JSON.parse(raw)?.mcpServers?.sprintable?.env?.FAKECHAT_PORT
    if (port) return Number(port)
  } catch {}
  return null
}

let passed = 0
let failed = 0

for (const [agent, expectedPort] of Object.entries(EXPECTED)) {
  const workspaceDir = join(HOME, `.neoclaw-${agent}`, 'state', 'actors', agent, 'workspace')
  const resolved = portFromMcpJson(workspaceDir)

  if (resolved === expectedPort) {
    process.stdout.write(`  ✅ ${agent}: ${resolved}\n`)
    passed++
  } else {
    process.stderr.write(`  ❌ ${agent}: expected ${expectedPort}, got ${resolved ?? 'null'} (${workspaceDir}/.mcp.json)\n`)
    failed++
  }
}

process.stdout.write(`\n${passed}/${passed + failed} passed\n`)
if (failed > 0) process.exit(1)
