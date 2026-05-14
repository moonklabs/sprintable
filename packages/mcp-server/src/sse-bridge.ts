/**
 * SSE Bridge — MCP stdio 서버가 FastAPI /api/v2/events/stream 에 자동 연결.
 * 이벤트 수신 시 onEvent 콜백 호출 + stderr 출력.
 * 연결 끊김 시 exponential backoff 재연결.
 */

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;
const JITTER_MS = 500;

export type SseBridgeEventHandler = (eventType: string, data: unknown) => void;

function log(msg: string) {
  process.stderr.write(`[sse-bridge] ${msg}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOnce(
  url: string,
  headers: Record<string, string>,
  onEvent?: SseBridgeEventHandler,
): Promise<void> {
  const response = await fetch(url, {
    headers: { ...headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
  });

  if (!response.ok) {
    throw new Error(`SSE connect failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('SSE response has no body');
  }

  log('connected');

  const decoder = new TextDecoder();
  let eventType = 'message';
  let dataLines: string[] = [];
  let remainder = '';

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        log('stream ended');
        break;
      }
      const text = decoder.decode(value, { stream: true });
      const lines = (remainder + text).split('\n');
      remainder = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        } else if (line === '') {
          if (dataLines.length > 0) {
            const dataStr = dataLines.join('\n');
            if (eventType !== 'heartbeat') {
              log(`event=${eventType} data=${dataStr}`);
              if (onEvent) {
                try {
                  const parsed = JSON.parse(dataStr);
                  onEvent(eventType, parsed);
                } catch {
                  onEvent(eventType, dataStr);
                }
              }
            }
            eventType = 'message';
            dataLines = [];
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function startSseBridge(
  pmApiUrl: string,
  agentApiKey: string,
  memberId: string,
  sseBackendUrl?: string,
  onEvent?: SseBridgeEventHandler,
): void {
  const baseUrl = (sseBackendUrl ?? pmApiUrl).replace(/\/$/, '');
  const url = `${baseUrl}/api/v2/events/stream?member_id=${memberId}`;
  const authHeaders = {
    Authorization: `Bearer ${agentApiKey}`,
    'x-agent-api-key': agentApiKey,
  };

  const run = async () => {
    let attempt = 0;
    while (true) {
      try {
        await connectOnce(url, authHeaders, onEvent);
        attempt = 0;
      } catch (err) {
        log(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      attempt++;
      const backoff = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      const jitter = Math.random() * JITTER_MS;
      const wait = Math.round(backoff + jitter);
      log(`reconnecting in ${wait}ms (attempt ${attempt})`);
      await delay(wait);
    }
  };

  void run();
}
