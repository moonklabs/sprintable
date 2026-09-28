/**
 * story #4398 ④ — **임시 관측**(dev만 · ④ 판정 뒤 걷음): 프런트 입구가 받는 X-Forwarded-For의 칸 수와 맨 오른쪽 값을 요청마다 한 줄 남긴다.
 * 같은 trace의 요청 로그 `httpRequest.remoteIp`와 맞대어 «XFF 오른쪽 끝 = 접속 주소(CF 대역인가)»를 가른다.
 *
 * - 스위치 `XFF_PROBE_ENABLED`(값이 정확히 "true"일 때만 · dev만 켬 · prod엔 안 실음).
 * - 남기는 값은 **주소와 칸 수뿐**: 주소 모양이 아니면 `non-ip` — 헤더 원문 · 쿠키 · 토큰은 로그에 안 섞인다.
 * - 한 줄 JSON(`event="xff_probe"`) — Cloud Run이 jsonPayload로 받는다. 프록시(미들웨어)는 소켓 주소를 못 보므로 peer는 없다.
 */
const EVENT = 'xff_probe';
const TRACE_RE = /^[0-9a-fA-F]{8,64}$/;
// 주소 모양만 통과(IPv4 · IPv6 글자와 길이) — 그 밖은 원문 대신 표지로 바꾼다.
const ADDRESS_RE = /^[0-9a-fA-F:.]{2,45}$/;

export function xffProbeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['XFF_PROBE_ENABLED'] === 'true';
}

function addressOrMarker(value: string | undefined): string {
  const v = value?.trim() ?? '';
  if (!v) return '';
  return ADDRESS_RE.test(v) ? v : 'non-ip';
}

export function xffProbeRecord(headers: Pick<Headers, 'get'>, service = 'frontend'): Record<string, string | number> {
  const xff = headers.get('x-forwarded-for') ?? '';
  const parts = xff ? xff.split(',') : [];
  const trace = (headers.get('x-cloud-trace-context') ?? '').split('/')[0] ?? '';
  return {
    event: EVENT,
    service,
    xff_hops: parts.length,
    xff_rightmost: parts.length ? addressOrMarker(parts.at(-1)) : '',
    trace_id: TRACE_RE.test(trace) ? trace : '',
  };
}

/** 스위치가 켜져 있을 때만 한 줄. 켜져 있으면 true. */
export function logXffProbe(headers: Pick<Headers, 'get'>, env: Record<string, string | undefined> = process.env): boolean {
  if (!xffProbeEnabled(env)) return false;
  console.log(JSON.stringify(xffProbeRecord(headers)));
  return true;
}
