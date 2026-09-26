/**
 * story #4320 — 라우트 테스트의 fetch 목이 돌려주던 **맨 객체**(`{ ok, status?, headers?, json }`)를 진짜 `Response`로 바꾼다.
 *
 * 왜: 직접 백엔드 fetch가 `backendFetch`(lib/backend-fetch.ts)를 거치며 본문을 시간 제한 안에서 다 읽는다(`arrayBuffer()`) — fetch 계약을
 * 지키지 않는 맨 객체 목은 거기서 깨졌다. 목의 뜻(상태 · 본문 · 헤더)은 그대로 두고 모양만 계약에 맞춘다. 진짜 Response는 그대로 통과.
 */
type PlainMock = {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string> | { get: (name: string) => string | null };
  json?: () => unknown;
  text?: () => unknown;
};

export async function asFetchResponse(value: unknown): Promise<Response> {
  if (value instanceof Response) return value;
  const mock = (value ?? {}) as PlainMock;
  const status = mock.status ?? (mock.ok === false ? 500 : 200);
  const headers = new Headers();
  const h = mock.headers;
  if (h && typeof (h as { get?: unknown }).get !== 'function') {
    for (const [k, v] of Object.entries(h as Record<string, string>)) headers.set(k, v);
  } else if (h && typeof (h as { get: (n: string) => string | null }).get === 'function') {
    // get 함수 목 — 흔히 쓰는 이름만 옮긴다(나머지는 null로 읽히던 것과 같다).
    for (const name of ['x-auth-correlation', 'location', 'retry-after', 'content-type', 'set-cookie']) {
      const v = (h as { get: (n: string) => string | null }).get(name);
      if (v != null) headers.set(name, v);
    }
  }
  let body: string | null = null;
  if (typeof mock.json === 'function') {
    body = JSON.stringify(await mock.json());
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (typeof mock.text === 'function') {
    body = String(await mock.text());
  }
  if ([101, 103, 204, 205, 304].includes(status)) body = null;
  return new Response(body, { status, headers });
}

/** `vi.stubGlobal('fetch', stubFetch(mockFetch))` — 목 호출(인자 단언)은 그대로, 돌려주는 값만 Response로. */
export function stubFetch(mockFetch: (...args: unknown[]) => unknown) {
  return async (...args: unknown[]) => asFetchResponse(await mockFetch(...args));
}
