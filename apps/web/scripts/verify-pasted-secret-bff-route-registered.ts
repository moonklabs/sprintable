/**
 * story #3813(Phase3·3-4 PR5-a CHANGES, 페드루 PO 確定 2026-09-12) — pasted_secret
 * 연결(wordpress·webhook·stibee…) 생성 BFF는 `[channel]` 동적 세그먼트가 아니라
 * 채널마다 리터럴 폴더(`channel-connections/<channel>/route.ts`)다(disconnect·
 * credentials·test 등 다른 하위 라우트는 `[channel]`로 이미 범용이지만, 생성
 * 엔드포인트만 이 관례를 안 따른다 — Next.js App Router 구조 자체의 제약).
 *
 * ⭐실사고(2026-09-12, 세 번째 재발) — `PASTED_SECRET_FIELDS`(pasted-secret-
 * connect-card.tsx)에 `stibee`를 등재했지만 대응 `channel-connections/stibee/
 * route.ts`를 안 만들어, 폼을 채워 제출해도 BFF 자체가 없어 항상 404였다(로컬
 * 라이브 캡처 중 발견). `wordpress`(story e4fc29fa)·`webhook`(같은 스토리)도
 * 각자 별도 사고로 같은 클래스가 이미 두 번 났었다(그 두 route.ts 파일의
 * docstring이 스스로 "PO 실측 404"라고 적어 뒀다) — 이 가드가 그 클래스를 CI에
 * 영구히 고정한다(추출이 아니라 선언 목록 순회 — 새 채널이 `PASTED_SECRET_FIELDS`
 * 에 늘 때마다 자동으로 검사 대상이 된다).
 *
 * ── 스코프 밖 ─────────────────────────────────────────────────────────
 * route.ts 파일이 실제로 POST를 export하는지·올바른 FastAPI 경로로 위임하는지는
 * 안 본다(타입체커·개별 route.test.ts 몫) — 이 가드는 순수하게 "파일 자체가
 * 있는가"만 본다(그게 3813 실사고의 정확한 결함 모양이었다).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANNEL_CONNECTIONS_API_DIR = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'api', 'organizations', '[id]', 'channel-connections',
);

export function findPastedSecretChannelsMissingBffRoute(
  declaredChannels: string[],
  routeFileExists: (channel: string) => boolean,
): string[] {
  return declaredChannels.filter((channel) => !routeFileExists(channel));
}

function realRouteFileExists(channel: string): boolean {
  return existsSync(join(CHANNEL_CONNECTIONS_API_DIR, channel, 'route.ts'));
}

async function main(): Promise<void> {
  const { PASTED_SECRET_FIELDS } = await import('../src/components/channel-connect/pasted-secret-connect-card');
  const declaredChannels = Object.keys(PASTED_SECRET_FIELDS);
  const missing = findPastedSecretChannelsMissingBffRoute(declaredChannels, realRouteFileExists);

  console.log(`[가드] pasted_secret 채널 ${declaredChannels.length}개(${declaredChannels.join(', ')}) — 각자 BFF route.ts 실존 대조`);

  if (missing.length > 0) {
    console.log(`\n❌ BFF route.ts가 없는 pasted_secret 채널 ${missing.length}개(폼을 채워도 제출이 404):`);
    for (const channel of missing) {
      console.log(`  - "${channel}" — apps/web/src/app/api/organizations/[id]/channel-connections/${channel}/route.ts 신설 필요(wordpress/webhook route.ts를 그대로 미러)`);
    }
    process.exit(1);
  }

  console.log('OK: pasted_secret 채널 전수 BFF route.ts 실존(폼 제출 404 없음)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
