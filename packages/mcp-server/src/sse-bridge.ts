/**
 * SSE Bridge — MCP stdio 서버가 FastAPI /api/v2/events/stream 에 자동 연결.
 * 이벤트 수신 시 onEvent 콜백 호출 + stderr 출력 + fakechat relay.
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

async function relayToFakechat(eventType: string, data: unknown): Promise<void> {
  const port = Number(process.env.FAKECHAT_PORT ?? 8787);
  const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let text: string;
  let threadId = '';
  if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    // payload가 중첩된 경우(chat:message 이벤트) payload에서 꺼냄
    const payload = (d.payload ?? d) as Record<string, unknown>;
    const senderRaw = payload.sender ?? d.sender_name ?? d.member_name ?? '';
    const senderName =
      typeof senderRaw === 'object' && senderRaw !== null
        ? String((senderRaw as Record<string, unknown>).name ?? '')
        : String(senderRaw);
    const content = payload.content ?? d.content ?? d.message ?? d.text ?? JSON.stringify(data);
    text = senderName ? `[${eventType}] ${senderName}: ${content}` : `[${eventType}] ${content}`;
    threadId = String(payload.thread_id ?? d.thread_id ?? '');
  } else {
    text = `[${eventType}] ${String(data)}`;
  }

  const form = new FormData();
  form.set('id', id);
  form.set('text', text);

  // 역방향 relay를 위해 thread_id + callback 정보 포함
  if (threadId) {
    const pmApiUrl = (process.env.PM_API_URL ?? '').replace(/\/$/, '');
    const agentApiKey = process.env.AGENT_API_KEY ?? '';
    form.set('thread_id', threadId);
    if (pmApiUrl && agentApiKey) {
      form.set('reply_callback_url', `${pmApiUrl}/api/v2/chats/${threadId}/messages`);
      form.set('reply_callback_api_key', agentApiKey);
    }
  }

  const res = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
              let parsed: unknown;
              try {
                parsed = JSON.parse(dataStr);
              } catch {
                parsed = dataStr;
              }
              if (onEvent) {
                onEvent(eventType, parsed);
              }
              relayToFakechat(eventType, parsed).catch((err) => {
                log(`fakechat relay error: ${err instanceof Error ? err.message : String(err)}`);
              });
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
