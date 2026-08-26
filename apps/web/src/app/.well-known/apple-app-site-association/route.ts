// §10.2 — iOS Universal Link 검증기가 인증 쿠키 없이 호출하는 자리(proxy.ts PUBLIC_PREFIX
// '/.well-known/'). 본문은 native-app-links.ts 단일 출처.
import { aasaRouteResponse } from '@/lib/native-app-links';

export async function GET() {
  return aasaRouteResponse();
}
