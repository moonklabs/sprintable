// story #3409 — CHANNEL_APP_CREDENTIALS_MISSING은 owner에게도 뜨는 코드라 role로 갈라야
// 한다(그 카드는 owner 전용, member 화면엔 없음 — role을 안 보면 없는 자리를 가리키는
// 거짓 문구가 나간다). OWNER_ONLY는 role 무관 단일 문구(다음 행동만 보강).
import { describe, expect, it } from 'vitest';
import koMessages from '../../../messages/ko.json';
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

  // story #3450 FE 후속(3653a18c §2·§3-0) — WordPress·webhook 붙여넣기 폼의 422 3종.
  it('⭐WORDPRESS_FIELDS_REQUIRED·WEBHOOK_FIELDS_REQUIRED·DESTINATION_INSECURE — 신규 3키', () => {
    expect(connectErrorLabelKey('WORDPRESS_FIELDS_REQUIRED', true)).toBe('channelConnectErrorWordpressFieldsRequired');
    expect(connectErrorLabelKey('WEBHOOK_FIELDS_REQUIRED', true)).toBe('channelConnectErrorWebhookFieldsRequired');
    expect(connectErrorLabelKey('CHANNEL_CONNECTION_DESTINATION_INSECURE', true)).toBe('channelConnectErrorDestinationInsecure');
  });

  // story #3813 PR5-a/PR5-b·CHANGES(페드루 PO 확認 2026-09-12) — 실 stibee 연결 폼
  // 422 3종(키·필드 4종 필수·auth-check 결과 2종).
  it('⭐STIBEE_FIELDS_REQUIRED·STIBEE_API_KEY_INVALID·STIBEE_AUTH_CHECK_UNAVAILABLE — 신규 3키', () => {
    expect(connectErrorLabelKey('STIBEE_FIELDS_REQUIRED', true)).toBe('channelConnectErrorStibeeFieldsRequired');
    expect(connectErrorLabelKey('STIBEE_API_KEY_INVALID', true)).toBe('channelConnectErrorStibeeApiKeyInvalid');
    expect(connectErrorLabelKey('STIBEE_AUTH_CHECK_UNAVAILABLE', true)).toBe('channelConnectErrorStibeeAuthCheckUnavailable');
  });

  // story #3816(Phase3·3-6 PR1, 페드루 PO 確定 2026-09-12) — Ghost 연결 폼 422
  // 3종(필드 누락·Admin API 키 검증 실패·site 검증 불가). stibee 3키와 동형.
  it('⭐GHOST_FIELDS_REQUIRED·GHOST_ADMIN_KEY_INVALID·GHOST_SITE_VERIFY_UNAVAILABLE — 신규 3키', () => {
    expect(connectErrorLabelKey('GHOST_FIELDS_REQUIRED', true)).toBe('channelConnectErrorGhostFieldsRequired');
    expect(connectErrorLabelKey('GHOST_ADMIN_KEY_INVALID', true)).toBe('channelConnectErrorGhostAdminKeyInvalid');
    expect(connectErrorLabelKey('GHOST_SITE_VERIFY_UNAVAILABLE', true)).toBe('channelConnectErrorGhostSiteVerifyUnavailable');
  });

  // story #3816 CHANGES 1(페드루 PO 지목 2026-09-12) — site_url 오타·Ghost 아닌
  // 사이트(흔히 404)는 키 오류와 다른 처방(주소를 고쳐야 풀림) — 별도 4번째 키.
  it('⭐GHOST_SITE_NOT_FOUND — 키 오류와 구분되는 신규 키', () => {
    expect(connectErrorLabelKey('GHOST_SITE_NOT_FOUND', true)).toBe('channelConnectErrorGhostSiteNotFound');
  });

  // story #3813 PR5-b CHANGES(페드루 PO 지적 2026-09-12) — BE가 sender_email·
  // sender_name까지 4필드 전부 필수로 넓어졌는데(PR5-b) FE 문구가 옛 2필드
  // ("API 키와 주소록 ID") 그대로 남아 있던 결함. 문구 자체를 4필드로 갱신했다 —
  // 이 테스트가 그 실 문구값을 고정한다(라벨 키 매핑만으론 문구 내용까지는
  // 안 잡힌다, connectErrorLabelKey 자체는 항상 옳았다).
  it('⭐STIBEE_FIELDS_REQUIRED 문구가 4필드(API 키·주소록 ID·발신자 이메일·이름) 전부를 말한다', () => {
    const key = connectErrorLabelKey('STIBEE_FIELDS_REQUIRED', true);
    const text = (koMessages.channelConnect as Record<string, string>)[key];
    expect(text).toContain('API 키');
    expect(text).toContain('주소록 ID');
    expect(text).toContain('발신자 이메일');
    expect(text).toContain('발신자 이름');
  });
});
