// story #3409 — CHANNEL_APP_CREDENTIALS_MISSING은 owner에게도 뜨는 코드라 role로 갈라야
// 한다(그 카드는 owner 전용, member 화면엔 없음 — role을 안 보면 없는 자리를 가리키는
// 거짓 문구가 나간다). OWNER_ONLY는 role 무관 단일 문구(다음 행동만 보강).
import { describe, expect, it } from 'vitest';
import { connectErrorLabelKey } from './connect-error';

describe('connectErrorLabelKey (story #3409)', () => {
  it('⭐CHANNEL_APP_CREDENTIALS_MISSING — owner는 화면 안(「앱 자격」)을 가리키는 전용 키', () => {
    expect(connectErrorLabelKey('CHANNEL_APP_CREDENTIALS_MISSING', true)).toBe(
      'channelConnectErrorAppCredentialsMissing',
    );
  });

  it('⭐CHANNEL_APP_CREDENTIALS_MISSING — member는 owner에게 요청하라는 별도 키(신규)', () => {
    expect(connectErrorLabelKey('CHANNEL_APP_CREDENTIALS_MISSING', false)).toBe(
      'channelConnectErrorAppCredentialsMissingMember',
    );
  });

  it('CHANNEL_CONNECTION_OWNER_ONLY — role 무관 한 문구(member면 애초에 이 화면 동작을 못 쓰므로 뜨는 대상이 member뿐이지만, 함수 자체는 role을 안 봄)', () => {
    expect(connectErrorLabelKey('CHANNEL_CONNECTION_OWNER_ONLY', true)).toBe('channelConnectErrorOwnerOnly');
    expect(connectErrorLabelKey('CHANNEL_CONNECTION_OWNER_ONLY', false)).toBe('channelConnectErrorOwnerOnly');
  });

  it('나머지 코드는 role과 무관하게 기존 테이블 그대로(회귀 0)', () => {
    expect(connectErrorLabelKey('SESSION_EXPIRED', true)).toBe('channelConnectErrorSessionExpired');
    expect(connectErrorLabelKey('SESSION_EXPIRED', false)).toBe('channelConnectErrorSessionExpired');
    expect(connectErrorLabelKey('OAUTH_PROVIDER_DENIED', false)).toBe('channelConnectErrorProviderDenied');
  });

  it('미지 code는 role과 무관하게 제네릭 폴백', () => {
    expect(connectErrorLabelKey('SOME_UNKNOWN_CODE', true)).toBe('channelConnectErrorGeneric');
    expect(connectErrorLabelKey('SOME_UNKNOWN_CODE', false)).toBe('channelConnectErrorGeneric');
  });
});
