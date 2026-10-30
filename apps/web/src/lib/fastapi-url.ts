/**
 * 백엔드(FastAPI) 기준 주소 — BFF 공용 프록시(fastapi-proxy.ts)와 서버 연결 풀(server-dispatcher.ts)이 같은 값을 쓴다.
 * story #4299 AC2: 연결 풀이 «백엔드 origin에만 h2 · 동시 스트림»을 걸어야 해서 두 자리가 한 곳에서 읽는다(갈리면 백엔드가
 * 외부 origin으로 분류돼 h2가 조용히 꺼진다).
 *
 * story 4824: the server side reads the address HERE and nowhere else. `NEXT_PUBLIC_*` is replaced by its value at build time — also written as
 * `process.env['NEXT_PUBLIC_…']` (measured: a marker value was found in 61 server files and 2 client chunks of the build) — so a server that picks its port
 * when it starts (the desktop app's own server) cannot be told its backend's address that way. `SPRINTABLE_API_ORIGIN` has no such prefix: it is read when
 * the process runs. Without it (every cloud / dev setup) nothing changes: the build-time value, then the local default.
 */
export function fastapiBaseUrl(): string {
  return process.env['SPRINTABLE_API_ORIGIN'] || process.env['NEXT_PUBLIC_FASTAPI_URL'] || 'http://localhost:8000';
}
