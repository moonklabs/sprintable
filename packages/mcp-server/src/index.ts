#!/usr/bin/env node

/**
 * @sprintable/mcp-server
 *
 * MCP 도구 서버 — stdio/SSE 모드 지원
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { configurePmApi } from './pm-api.js';
import { registerCoreTools } from './tools/core.js';
import { registerRetroTools } from './tools/retro.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerStandupRetroTools } from './tools/standup-retro.js';
import { registerDocsTools } from './tools/docs.js';
import { registerStoriesTools } from './tools/stories.js';
import { registerTasksTools } from './tools/tasks.js';
import { registerSprintsTools } from './tools/sprints.js';
import { registerEpicsTools } from './tools/epics.js';
import { registerRewardsTools } from './tools/rewards.js';
import { registerMeetingTools } from './tools/meetings.js';
import { registerMemosTools } from './tools/memos.js';
import { registerNotificationsTools } from './tools/notifications.js';
import { registerStandupsTools } from './tools/standups.js';
import { registerAgentRunsTools } from './tools/agent-runs.js';

const PM_API_URL = process.env['PM_API_URL'] ?? '';
const AGENT_API_KEY = process.env['AGENT_API_KEY'] ?? '';
const MCP_API_KEY = process.env['MCP_API_KEY'] ?? '';
const MODE = process.env['MCP_MODE'] ?? 'stdio'; // 'stdio' | 'sse'
const PORT = Number(process.env['MCP_PORT'] ?? '3100');

if (!PM_API_URL || !AGENT_API_KEY) {
  console.error('Error: PM_API_URL and AGENT_API_KEY environment variables required');
  process.exit(1);
}

configurePmApi(PM_API_URL, AGENT_API_KEY);

const server = new McpServer({
  name: 'sprintable-mcp',
  version: '0.0.1',
});

// 도구 등록
registerCoreTools(server);
registerRetroTools(server);
registerAnalyticsTools(server);
registerStandupRetroTools(server);
registerDocsTools(server);
registerStoriesTools(server);
registerTasksTools(server);
registerSprintsTools(server);
registerEpicsTools(server);
registerRewardsTools(server);
registerMeetingTools(server);
registerMemosTools(server);
registerNotificationsTools(server);
registerStandupsTools(server);
registerAgentRunsTools(server);

async function main() {
  if (MODE === 'sse') {
    // SSE 모드
    const { createServer } = await import('http');
    let sseTransport: SSEServerTransport | null = null;

    const httpServer = createServer(async (req, res) => {
      // SSE 인증: MCP_API_KEY가 설정되어 있으면 Bearer 검증
      if (MCP_API_KEY && req.url !== '/') {
        const auth = req.headers['authorization'];
        if (!auth || auth !== `Bearer ${MCP_API_KEY}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      if (req.url === '/sse') {
        sseTransport = new SSEServerTransport('/messages', res);
        await server.connect(sseTransport);
      } else if (req.url === '/messages' && req.method === 'POST') {
        if (sseTransport) {
          await sseTransport.handlePostMessage(req, res);
        } else {
          res.writeHead(400);
          res.end('No active SSE connection');
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'sprintable-mcp', version: '0.0.1', mode: 'sse' }));
      }
    });

    httpServer.listen(PORT, () => {
      console.log(`Sprintable MCP Server (SSE) listening on port ${PORT}`);
    });
  } else {
    // stdio 모드 (기본)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Sprintable MCP Server (stdio) connected');
  }
}

main().catch((err) => {
  console.error('MCP Server failed:', err);
  process.exit(1);
});

export { server };
