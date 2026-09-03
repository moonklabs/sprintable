import { describe, test, expect } from 'vitest';
import {
  deriveChannelConnectionStatus,
  channelConnectionStatusLabelKey,
  CHANNEL_CONNECTION_STATUS_TONE,
  worstChannelConnectionStatus,
  type ChannelConnectionStatusInput,
  type ChannelConnectionStatusResult,
} from './connection-status';

const NOW = new Date('2026-09-03T00:00:00Z');
const iso = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 60 * 60 * 1000).toISOString();

// story #3376 — 5상태 진리표. 파생 입력은 정확히 넷(status·token_expires_at·
// can_auto_refresh·last_error)이고, config_incomplete은 오늘 도달 불가(파일 헤더 참고).
const CASES: Array<{ name: string; input: ChannelConnectionStatusInput; expected: ChannelConnectionStatusResult }> = [
  { name: '연결 행 없음 → 미연결', input: {}, expected: { status: 'not_connected' } },
  {
    name: 'active + 만료 없음(=WordPress 앱 비밀번호류) → 연결됨',
    input: { serverStatus: 'active', tokenExpiresAt: null, now: NOW },
    expected: { status: 'connected' },
  },
  {
    name: 'active + 만료가 임계값(48h) 밖 → 연결됨',
    input: { serverStatus: 'active', tokenExpiresAt: iso(72), now: NOW },
    expected: { status: 'connected' },
  },
  {
    name: '⭐active + 만료 임박(48h 이내) + can_auto_refresh=true → 만료 임박(정보)',
    input: { serverStatus: 'active', tokenExpiresAt: iso(6), canAutoRefresh: true, now: NOW },
    expected: { status: 'expiring_soon', isAutoRefreshInfo: true },
  },
  {
    name: '⭐active + 만료 임박(48h 이내) + can_auto_refresh=false → 만료 임박(할 일)',
    input: { serverStatus: 'active', tokenExpiresAt: iso(6), canAutoRefresh: false, now: NOW },
    expected: { status: 'expiring_soon', isAutoRefreshInfo: false },
  },
  {
    name: '⭐expired → 재인증 필요(사유: expired — 다시 연결하면 풀림)',
    input: { serverStatus: 'expired', now: NOW },
    expected: { status: 'reauth_required', reauthReason: 'expired' },
  },
  {
    name: '⭐revoked → 재인증 필요(사유: revoked — 채널 쪽에서 권한을 뺏김)',
    input: { serverStatus: 'revoked', now: NOW },
    expected: { status: 'reauth_required', reauthReason: 'revoked' },
  },
  {
    name: '⭐error → 재인증 필요(사유: error — 갱신 실패, 이유는 last_error가 원문으로 보존)',
    input: { serverStatus: 'error', lastError: 'Meta API 500', now: NOW },
    expected: { status: 'reauth_required', reauthReason: 'error' },
  },
];

describe('deriveChannelConnectionStatus (story #3376, doc phase1-channel-connect-screen-design §3-0 — 진리표)', () => {
  for (const { name, input, expected } of CASES) {
    test(name, () => {
      expect(deriveChannelConnectionStatus(input)).toEqual(expected);
    });
  }

  test('§3-0 핵심 — expired·revoked·error는 같은 reauth_required 상태여도 reauthReason으로 갈린다(한 문구로 뭉치지 않는다)', () => {
    const reasons = (['expired', 'revoked', 'error'] as const).map(
      (s) => deriveChannelConnectionStatus({ serverStatus: s, now: NOW }).reauthReason,
    );
    expect(new Set(reasons).size).toBe(3);
  });

  test('§3-0-1 핵심 — 만료 임박의 정보/할 일 갈림은 can_auto_refresh 하나로만 결정된다(토큰 컬럼 추측 없음)', () => {
    // 같은 입력에서 canAutoRefresh만 다르면 결과도 정확히 그만큼만 다르다 — 다른 필드로
    // 새는 로직이 없다는 것을 고정한다.
    const withRefresh = deriveChannelConnectionStatus({ serverStatus: 'active', tokenExpiresAt: iso(1), canAutoRefresh: true, now: NOW });
    const withoutRefresh = deriveChannelConnectionStatus({ serverStatus: 'active', tokenExpiresAt: iso(1), canAutoRefresh: false, now: NOW });
    expect(withRefresh.status).toBe(withoutRefresh.status);
    expect(withRefresh.isAutoRefreshInfo).not.toBe(withoutRefresh.isAutoRefreshInfo);
  });
});

describe('worstChannelConnectionStatus (doc §8-1 — 채널 행은 계정 중 최악으로 승격)', () => {
  test('빈 배열 → 미연결', () => {
    expect(worstChannelConnectionStatus([])).toBe('not_connected');
  });

  test('⭐하나라도 재인증 필요면 채널 전체가 재인증 필요(가장 급한 것이 이긴다)', () => {
    expect(worstChannelConnectionStatus(['connected', 'expiring_soon', 'reauth_required'])).toBe('reauth_required');
  });

  test('연결됨과 미연결이 섞이면 연결됨이 이긴다(정보 없음보다 급하다)', () => {
    expect(worstChannelConnectionStatus(['not_connected', 'connected'])).toBe('connected');
  });
});

describe('CHANNEL_CONNECTION_STATUS_TONE / channelConnectionStatusLabelKey — 다섯 상태 전부 정의', () => {
  test('다섯 상태 모두 tone·labelKey가 존재한다', () => {
    const statuses: Array<ChannelConnectionStatusResult['status']> = [
      'not_connected', 'config_incomplete', 'connected', 'expiring_soon', 'reauth_required',
    ];
    for (const status of statuses) {
      expect(CHANNEL_CONNECTION_STATUS_TONE[status]).toBeDefined();
      expect(channelConnectionStatusLabelKey(status)).toMatch(/^channelStatus/);
    }
  });
});
