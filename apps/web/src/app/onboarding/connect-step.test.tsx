// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ConnectStep, inferTransport, maskApiKey } from './connect-step';
import { RAIL_ORDER, HTTP_RAIL_ORDER, VERIFY_TIMEOUT_MS } from './verify-rail';
import ko from '../../../messages/ko.json';

describe('inferTransport (E-MCP-OPT S3 — transport 미지정 default-resolve 응답 판별)', () => {
  it('reads type:"http" from a hosted artifact', () => {
    const content = JSON.stringify({
      mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://mcp.sprintable.ai/mcp', headers: {} } },
    });
    expect(inferTransport(content)).toBe('http');
  });

  it('reads type:"stdio" from a local artifact', () => {
    const content = JSON.stringify({
      mcpServers: { 'sprintable-mcp': { type: 'stdio', command: 'uvx', args: ['sprintable-mcp'] } },
    });
    expect(inferTransport(content)).toBe('stdio');
  });

  it('falls back to stdio on malformed content (never throws, never defaults to hosted)', () => {
    expect(inferTransport('not json')).toBe('stdio');
    expect(inferTransport('{}')).toBe('stdio');
  });
});

describe('rail orders (E-MCP-OPT S3 — transport-aware verify rail shape)', () => {
  it('stdio rail keeps the full 6-stage canonical order (regression guard)', () => {
    expect(RAIL_ORDER).toEqual([
      'config_copied', 'waiting', 'mcp_reachable', 'event_delivered', 'ack', 'verified',
    ]);
  });

  it('http rail is a 4-stage reduction with no event_delivered/ack (structurally impossible over http)', () => {
    expect(HTTP_RAIL_ORDER).toEqual(['config_copied', 'waiting', 'mcp_reachable', 'verified']);
    expect(HTTP_RAIL_ORDER).not.toContain('event_delivered');
    expect(HTTP_RAIL_ORDER).not.toContain('ack');
  });
});

// story #4cdad425 — 표시 렌더 테스트(카디르 QA 후속·비차단 갭 보강). 훅 상태(timedOut/awaitingVerification)가
// 아니라 connect-step.tsx가 그 상태에서 «실제로» 재시작 콜아웃·대기 표시·타임아웃 힌트를 렌더하는가를
// 마운트해 DOM으로 잰다(코드베이스 마운트 패턴: jsdom + createRoot + React.act). 조건 배선이 지워지면
// 이 assert가 실패하도록 각 문구를 직접 확認한다(양성대조 — 표시가 곧 이 fix의 값이므로 그 축을 덮는다).
describe('ConnectStep — story #4cdad425 (검증 안내 표시 렌더)', () => {
  const RESTART = '재시작해야 새 연결이 적용됩니다'; // restartAfterConfig
  const WAITING = '연결을 확인하는 중이에요'; // verifyWaiting
  const TIMEOUT = '아직 연결이 확인되지 않았어요'; // verifyTimeoutTitle

  function makeFetch(verified: boolean) {
    return vi.fn(async (url: string) => {
      if (url.includes('connection-artifact')) {
        // story #3192 — BE 실 응답 shape(`{data: {files: [{filename, content}]}}`, agents.py::
        // _connection_artifact) 그대로. 옛 `{data: {content}}` 단일필드 mock은 실제로는 이미
        // 존재하지 않는 shape을 검증하고 있었다(그린인데 틀린 테스트 — 이 스토리의 근본원인).
        return {
          ok: true,
          json: async () => ({
            data: {
              files: [{
                filename: '.mcp.json',
                content: JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://mcp.x/mcp', headers: {}, env: { AGENT_API_KEY: '<YOUR_AGENT_API_KEY>' } } } }),
              }],
              mcp_config: null,
              api_key: null,
            },
          }),
        };
      }
      if (url.includes('verification-status')) {
        const rail = verified
          ? [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'done' }, { state: 'mcp_reachable', status: 'done' }, { state: 'verified', status: 'done' }]
          : [{ state: 'config_copied', status: 'done' }, { state: 'waiting', status: 'active' }];
        return { ok: true, json: async () => ({ data: { verified, rail } }) };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mount(verified = false) {
    global.fetch = makeFetch(verified);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
          <ConnectStep agentId="a1" apiKey="sk_live_1234" onFinish={() => {}} />
        </NextIntlClientProvider>,
      );
      // 최초 아티팩트 fetch → transport 해소 → 폴 effect → verification-status fetch까지 마이크로태스크 flush.
      await vi.advanceTimersByTimeAsync(100);
    });
  }

  it('① 재시작 안내 콜아웃이 상시 렌더된다(누락됐던 필수 단계 — 이 fix의 핵심)', async () => {
    await mount();
    expect(container.textContent).toContain(RESTART);
  });

  it('② 폴링 중(미검증)엔 대기 표시가 뜨고 타임아웃 힌트는 아직 안 뜬다', async () => {
    await mount(false);
    expect(container.textContent).toContain(WAITING);
    expect(container.textContent).not.toContain(TIMEOUT);
  });

  it('③ 타임아웃 지나면 진단 힌트가 뜨고 대기 표시는 사라진다(두 상태 상호배타)', async () => {
    await mount(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 100); });
    expect(container.textContent).toContain(TIMEOUT);
    expect(container.textContent).not.toContain(WAITING);
  });

  it('④ 검증 성공이면 대기·타임아웃 표시가 둘 다 안 뜬다', async () => {
    await mount(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 100); });
    expect(container.textContent).not.toContain(WAITING);
    expect(container.textContent).not.toContain(TIMEOUT);
  });
});

// story #3192(온보딩·크럭스) — 신규 계정이 connect 스텝에서 API 키를 한 번도 못 받던 근본원인의
// pin. BE 응답 shape이 `{files: [{filename, content}]}`인데(agents.py::_connection_artifact,
// AgentConnectionSettingsSection이 이미 그렇게 소비 중이었음) 이 파일의 fetchArtifact만 옛
// `{content}` 단일필드를 읽어 항상 undefined → 아티팩트가 영구 pending에 갇히고, 실 API 키를
// 대입할 자리(renderArtifact) 자체에 도달하지 못했다.
describe('ConnectStep — story #3192 (연결 아티팩트 shape 회귀 pin)', () => {
  const PENDING = '연결 설정 생성 중…'; // artifactPending
  const ERROR = '설정을 불러오지 못했습니다'; // artifactError
  const REAL_KEY = 'sk_live_realkey0001';

  function makeArtifactFetch(kind: 'real-shape' | 'stale-shape' | 'empty-files') {
    return vi.fn(async (url: string) => {
      if (url.includes('connection-artifact')) {
        if (kind === 'stale-shape') {
          // 이 스토리 착수 前 실제로 왔던 응답 — content가 top-level에 없다(BE가 이미 files[]로
          // 바뀐 뒤). 픽스 前에는 이걸 파싱 실패로도 못 알아채고 계속 "생성 중…"만 보여줬다.
          return { ok: true, json: async () => ({ data: { content: 'stale-shape-should-not-exist' } }) };
        }
        const files = kind === 'empty-files' ? [] : [{ filename: '.mcp.json', content: JSON.stringify({ mcpServers: { 'sprintable-mcp': { type: 'stdio', command: 'uvx', args: ['sprintable-mcp'], env: { AGENT_API_KEY: '<YOUR_AGENT_API_KEY>' } } } }) }];
        return { ok: true, json: async () => ({ data: { files, mcp_config: null, api_key: null } }) };
      }
      if (url.includes('verification-status')) {
        return { ok: true, json: async () => ({ data: { verified: false, rail: [{ state: 'config_copied', status: 'active' }] } }) };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mount(kind: 'real-shape' | 'stale-shape' | 'empty-files') {
    global.fetch = makeArtifactFetch(kind);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
          <ConnectStep agentId="a1" apiKey={REAL_KEY} onFinish={() => {}} />
        </NextIntlClientProvider>,
      );
      await vi.advanceTimersByTimeAsync(100);
    });
  }

  it('실 BE shape(files[]) 응답이면 아티팩트가 채워지고 placeholder가 실 키(마스킹)로 치환된다(고착 재현 없음)', async () => {
    await mount('real-shape');
    expect(container.textContent).not.toContain(PENDING);
    // 화면 표시는 마스킹(maskApiKey — display=마스킹/copy=실키, renderArtifact 계약)이라
    // 평문 REAL_KEY는 그대로 나오지 않는다 — placeholder가 사라지고 마스킹 형태가 온 것으로
    // "치환이 실제로 일어났다"를 확인한다(치환 전이면 `<YOUR_AGENT_API_KEY>`가 그대로 남는다).
    expect(container.textContent).not.toContain('<YOUR_AGENT_API_KEY>');
    expect(container.textContent).toContain(maskApiKey(REAL_KEY));
  });

  it('옛 shape(content 단일필드) 응답이면 "생성 중…"에 영구 고착하지 않고 정직한 에러로 전환된다', async () => {
    await mount('stale-shape');
    expect(container.textContent).not.toContain(PENDING);
    expect(container.textContent).toContain(ERROR);
    expect(container.textContent).toContain('다시 시도'); // artifactRetry 버튼 동반
  });

  it('files가 빈 배열이어도(.mcp.json 부재) 같은 정직한 에러 경로를 탄다', async () => {
    await mount('empty-files');
    expect(container.textContent).not.toContain(PENDING);
    expect(container.textContent).toContain(ERROR);
  });
});
