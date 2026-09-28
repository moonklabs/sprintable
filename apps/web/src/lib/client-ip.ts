/**
 * story #4398 — 백엔드 요청 상한이 셀 **사용자 IP**를 프런트(BFF)가 한 번 정해 넘긴다(신뢰 경계 한 곳).
 *
 * - 접속 주소 = X-Forwarded-For **오른쪽 끝**: Cloud Run 앞단(GFE)이 실제로 접속한 주소를 붙이는 칸이라 클라이언트가 못 꾸민다.
 * - 접속 주소가 **Cloudflare 대역**이면 사용자 IP = `CF-Connecting-IP`(Cloudflare가 붙임). 아니면(= run.app 직통) 접속 주소 그대로 —
 *   직통 요청이 꾸민 `CF-Connecting-IP`는 무시한다.
 * - 백엔드로는 `X-Sprintable-Client-IP` + `X-Sprintable-Edge-Key`(공유 비밀 `EDGE_CLIENT_IP_SECRET`)를 싣는다. 비밀이 없으면 아무것도
 *   안 싣는다 — 백엔드가 자기 앞단의 접속 주소로 센다(오늘과 같음 · 배포 순서에 안 막힘).
 *
 * ⚠️ «XFF 오른쪽 끝 = 접속 주소»는 dev 로그 실측(4398 AC0 ④)이 전제 — 확인 전엔 병합하지 않는다.
 * Node 런타임 전용(`node:net`) — BFF 라우트 핸들러에서만 쓴다.
 */
import { BlockList, isIP } from 'node:net';

/**
 * Cloudflare가 공개한 자기 대역. 출처: https://www.cloudflare.com/ips-v4 · https://www.cloudflare.com/ips-v6 (2026-09-28 조회).
 * 목록은 드물게 바뀐다 — 바뀌면 이 상수와 날짜를 함께 갱신한다.
 */
export const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
] as const;
export const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
] as const;

export const CLIENT_IP_HEADER = 'X-Sprintable-Client-IP';
export const EDGE_KEY_HEADER = 'X-Sprintable-Edge-Key';

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_IPV4_RANGES) {
  const [net, prefix] = range.split('/');
  cloudflare.addSubnet(net, Number(prefix), 'ipv4');
}
for (const range of CLOUDFLARE_IPV6_RANGES) {
  const [net, prefix] = range.split('/');
  cloudflare.addSubnet(net, Number(prefix), 'ipv6');
}

function validIp(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  return isIP(v) ? v : null;
}

export function isCloudflareAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return cloudflare.check(ip, 'ipv4');
  if (family === 6) return cloudflare.check(ip, 'ipv6');
  return false;
}

/** 들어온 요청 헤더로 사용자 IP를 정한다. 못 정하면 null(로컬 · 헤더 없음). */
export function resolveClientIp(headers: Pick<Headers, 'get'>): string | null {
  const xff = headers.get('x-forwarded-for');
  const connecting = validIp(xff?.split(',').at(-1));
  if (!connecting) return null;
  if (isCloudflareAddress(connecting)) {
    return validIp(headers.get('cf-connecting-ip')) ?? connecting;
  }
  return connecting;
}

/** 백엔드로 실을 두 헤더 — 비밀 · 사용자 IP가 다 있을 때만. */
export function edgeClientIpHeaders(
  incoming: Pick<Headers, 'get'> | null | undefined,
  secret: string | undefined = process.env['EDGE_CLIENT_IP_SECRET'],
): Record<string, string> {
  if (!secret || !incoming) return {};
  const ip = resolveClientIp(incoming);
  if (!ip) return {};
  return { [CLIENT_IP_HEADER]: ip, [EDGE_KEY_HEADER]: secret };
}
