// story #3376(Phase1·마케팅운영, doc phase1-channel-connect-screen-design §3-0) — 화면 상태
// 다섯은 저장하지 않고 서버가 이미 주는 신호에서 파생한다(Phase 0 post-status.ts와 같은
// 원칙 — 두 벌로 갈리는 판정을 만들지 않는다).
//
// 'config_incomplete'(설정 미완) 정정 이력 — 최초엔 "Threads는 credential_kind가 항상
// oauth라 필수값 개념이 없다"고 보고 이 상태를 파생 불가로 문서화했었다. PR#3736이 실제로
// 「채널 앱 자격」(GET .../app-credentials → effective_source: 'org'|'platform'|'none')을
// 얹으며 그 전제가 깨졌다 — Sprintable 공용 앱(platform)도 조직 자격(org)도 없으면
// (`effective_source==='none'`) authorize가 409 CHANNEL_APP_CREDENTIALS_MISSING을 낸다.
// 이 신호는 **연결 행이 아예 없을 때만** 최종 상태에 영향을 준다 — 이미 연결된 행이
// 있다는 것 자체가 그 연결을 만든 시점엔 자격이 있었다는 뜻이라(연결 뒤 자격을 지워도
// 기존 연결은 안 끊긴다, PR#3736 스코프) 재판정하지 않는다.
// story #3813 PR5-b CHANGES(유나 Design REQUESTED, PO 확定 2026-09-12) — 「다시
// 연결」칩·버튼은 재연결로 실제로 풀리는 오류(expired·revoked·이유 불명 error)
// 전용이었다. STIBEE_PLAN_RESTRICTED/STIBEE_SENDER_NOT_VERIFIED는 코드 자신이
// 이미 `kind:'provider_error'`(api-error.ts)로 아는, 재연결로 안 풀리는 별개
// 축(사람이 스티비 쪽에서 직접 고쳐야 한다) — 같은 reauth_required로 뭉치면
// 「다시 연결」이 거짓 진입점이 된다. 별도 상태로 갈라 칩·버튼이 그 앎을
// 자동으로 따라오게 한다(page.tsx마다 흩어진 분기 대신 파생 한 곳).
export type ChannelConnectionStatus =
  | 'not_connected'
  | 'config_incomplete'
  | 'connected'
  | 'expiring_soon'
  | 'reauth_required'
  | 'provider_error';

// 오늘 알려진 provider_error 코드 둘 다 stibee(요금제 제한·발신자 미인증) — 새
// 코드가 늘면 여기 추가(지어내지 않는다, api-error.ts KNOWN_ERRORS의 kind:
// 'provider_error'와 같은 코드 값이어야 한다).
const PROVIDER_ERROR_CODES = new Set(['STIBEE_PLAN_RESTRICTED', 'STIBEE_SENDER_NOT_VERIFIED']);

export type ChannelConnectionReauthReason = 'expired' | 'revoked' | 'error';

export interface ChannelConnectionStatusInput {
  /** 이 (channel, account) 연결 행 자체가 없으면 undefined — '미연결'. */
  serverStatus?: 'active' | 'expired' | 'revoked' | 'error';
  tokenExpiresAt?: string | null;
  canAutoRefresh?: boolean;
  lastError?: string | null;
  /** story #3813 PR5-b CHANGES — provider_error 판정 전용(PROVIDER_ERROR_CODES
   * 대조). lastError(원문 메시지)와 다른 필드 — last_error_code(구조화 코드). */
  lastErrorCode?: string | null;
  /** 만료 임박 판정 임계값(ms) — 테스트가 시각을 주입할 수 있게 now도 분리. */
  now?: Date;
  expiringSoonThresholdMs?: number;
  /** GET .../app-credentials의 effective_source. serverStatus가 undefined(연결 행 없음)일
   * 때만 참조한다 — 'none'이면 '설정 미완'(연결 시작 자체가 막힘), 'org'/'platform'이면
   * 그냥 '미연결'(자격은 있으니 버튼만 누르면 된다). */
  effectiveSource?: 'org' | 'platform' | 'none';
}

export interface ChannelConnectionStatusResult {
  status: ChannelConnectionStatus;
  /** status==='reauth_required'일 때만 채워진다 — 유나 §3-0 "재인증 필요 한 칩은 유지
   * 하되 칩 옆 한 줄이 셋을 갈라야 한다"(expired=다시 연결하면 풀림·revoked=채널 쪽에서
   * 뺏김·error=이유를 모른다). 세 갈래를 한 문구로 뭉치면 사람이 할 일을 못 고른다. */
  reauthReason?: ChannelConnectionReauthReason;
  /** status==='expiring_soon'일 때만 의미 있다 — true면 "정보"(자동 갱신됩니다), false면
   * "할 일"(직접 다시 연결해야 합니다). encrypted_refresh_token 등 컬럼으로 추측하지
   * 않는다(§3-0-1 — Threads는 refresh token 없이 재발급되는 채널이라 그 추측이 조용히
   * 틀린다, 서버가 이미 계산해 주는 can_auto_refresh만 신뢰). */
  isAutoRefreshInfo?: boolean;
}

const DEFAULT_EXPIRING_SOON_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48h — PR#3736 cron 임계값과 동일

export function deriveChannelConnectionStatus(
  input: ChannelConnectionStatusInput,
): ChannelConnectionStatusResult {
  if (input.serverStatus === undefined) {
    if (input.effectiveSource === 'none') return { status: 'config_incomplete' };
    return { status: 'not_connected' };
  }
  if (input.serverStatus === 'expired') {
    return { status: 'reauth_required', reauthReason: 'expired' };
  }
  if (input.serverStatus === 'revoked') {
    return { status: 'reauth_required', reauthReason: 'revoked' };
  }
  if (input.serverStatus === 'error') {
    if (input.lastErrorCode && PROVIDER_ERROR_CODES.has(input.lastErrorCode)) {
      return { status: 'provider_error' };
    }
    return { status: 'reauth_required', reauthReason: 'error' };
  }
  // 여기부터 serverStatus === 'active'.
  if (input.tokenExpiresAt) {
    const now = input.now ?? new Date();
    const threshold = input.expiringSoonThresholdMs ?? DEFAULT_EXPIRING_SOON_THRESHOLD_MS;
    const expiresAtMs = new Date(input.tokenExpiresAt).getTime();
    if (expiresAtMs - now.getTime() <= threshold) {
      // 뮤테이션 대상(스토리 본문 명시) — 이 분기(can_auto_refresh 판정)를 제거하면
      // "재발급형 채널의 만료 임박=정보" 테스트가 반드시 실패해야 한다.
      return { status: 'expiring_soon', isAutoRefreshInfo: input.canAutoRefresh === true };
    }
  }
  return { status: 'connected' };
}

// doc §3-0(유나) — Phase 0 §6-2-1 톤 규율 그대로 재사용(tint bg+순색 dot+text-foreground).
// 'config_incomplete'은 Phase 0의 'approved(발행 대기)'와 같은 자리(성공이 아니라 진행 중)
// — info 계열. 'expiring_soon'은 아직 살아있으니 warning, 'reauth_required'는 이미
// 못 하고 있으니 destructive.
export const CHANNEL_CONNECTION_STATUS_TONE: Record<
  ChannelConnectionStatus,
  { bg: string; dot: string; text: string }
> = {
  not_connected: { bg: 'bg-muted', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  config_incomplete: { bg: 'bg-info-tint', dot: 'bg-info', text: 'text-foreground' },
  connected: { bg: 'bg-success-tint', dot: 'bg-success', text: 'text-foreground' },
  expiring_soon: { bg: 'bg-warning-tint', dot: 'bg-warning', text: 'text-foreground' },
  reauth_required: { bg: 'bg-destructive-tint', dot: 'bg-destructive', text: 'text-foreground' },
  // provider_error도 지금 발행이 안 되는 건 reauth_required와 같다(destructive) —
  // 다른 건 "무엇을 해야 하는가"(사람이 스티비 쪽에서 고친다)뿐, 급함은 같다.
  provider_error: { bg: 'bg-destructive-tint', dot: 'bg-destructive', text: 'text-foreground' },
};

export function channelConnectionStatusLabelKey(status: ChannelConnectionStatus): string {
  switch (status) {
    case 'not_connected': return 'channelStatusNotConnected';
    case 'config_incomplete': return 'channelStatusConfigIncomplete';
    case 'connected': return 'channelStatusConnected';
    case 'expiring_soon': return 'channelStatusExpiringSoon';
    case 'reauth_required': return 'channelStatusReauthRequired';
    // 제네릭 폴백(오늘은 항상 page.tsx가 stibee 코드별 구체 문구로 덮어쓴다 —
    // ChannelStatusChip의 label prop 참고, 미지 provider_error 코드 대비 안전망).
    case 'provider_error': return 'channelStatusProviderError';
  }
}

// doc §8-1(유나) — 채널 행(여러 계정을 가질 수 있다, UNIQUE(org_id,channel,account_id))의
// 상태는 계정 중 최악으로 승격한다. 순서는 "얼마나 급한 할 일인가": 재인증 필요(이미 못
// 함) > 만료 임박(곧 못 함) > 설정 미완 > 연결됨 > 미연결(정보 없음이 가장 안 급하다).
const SEVERITY_ORDER: ChannelConnectionStatus[] = [
  'reauth_required', 'provider_error', 'expiring_soon', 'config_incomplete', 'connected', 'not_connected',
];

export function worstChannelConnectionStatus(statuses: ChannelConnectionStatus[]): ChannelConnectionStatus {
  if (statuses.length === 0) return 'not_connected';
  for (const s of SEVERITY_ORDER) {
    if (statuses.includes(s)) return s;
  }
  return 'not_connected';
}
