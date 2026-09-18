import { describe, expect, it } from 'vitest';
import { PASTED_SECRET_FIELDS } from '../src/components/channel-connect/pasted-secret-connect-card';
import { findPastedSecretChannelsMissingBffRoute } from './verify-pasted-secret-bff-route-registered';

describe('findPastedSecretChannelsMissingBffRoute — 순수 판정 함수', () => {
  it('전 채널에 route.ts가 있으면 위반 0건이다', () => {
    const violations = findPastedSecretChannelsMissingBffRoute(
      ['wordpress', 'webhook'],
      (channel) => channel === 'wordpress' || channel === 'webhook',
    );
    expect(violations).toEqual([]);
  });

  // ⭐양성대조 — 2026-09-12 실사고(stibee) 그대로 모사: PASTED_SECRET_FIELDS엔
  // 등재됐지만 route.ts는 없는 상태. fix 전 코드였다면 이 케이스를 잡을 수단이
  // 없었다 — 판정 함수가 정확히 이 모양에서 RED가 나는지 고정한다.
  it('stibee 실사고 픽스처 — route.ts가 없는 채널을 잡는다(양성대조)', () => {
    const violations = findPastedSecretChannelsMissingBffRoute(
      ['wordpress', 'webhook', 'stibee'],
      (channel) => channel === 'wordpress' || channel === 'webhook', // stibee 누락
    );
    expect(violations).toEqual(['stibee']);
  });

  it('여러 채널이 동시에 빠져도 전부 잡는다', () => {
    const violations = findPastedSecretChannelsMissingBffRoute(['a', 'b', 'c'], (channel) => channel === 'a');
    expect(violations).toEqual(['b', 'c']);
  });
});

// story #3813 PR5-a CHANGES — 실 데이터(pasted-secret-connect-card.tsx의
// PASTED_SECRET_FIELDS) 전수 대조. 이 테스트가 RED면 CI 가드 스크립트(main())도
// 똑같이 RED다(같은 함수를 그대로 쓴다 — 여긴 순수함수만 임포트해 fs 없이 검증).
describe('실 데이터(PASTED_SECRET_FIELDS) 대조', () => {
  it('현재 등재된 pasted_secret 채널 전수에 실제 route.ts 파일이 있다(stibee 재발 없음)', async () => {
    const { existsSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'api', 'organizations', '[id]', 'channel-connections');
    const violations = findPastedSecretChannelsMissingBffRoute(
      Object.keys(PASTED_SECRET_FIELDS),
      (channel) => existsSync(join(dir, channel, 'route.ts')),
    );
    expect(violations).toEqual([]);
  });
});
