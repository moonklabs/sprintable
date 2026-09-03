// story #3376(Phase1·마케팅운영, doc phase1-channel-connect-screen-design §3-0) — 화면 상태
// 다섯은 저장하지 않고 서버가 이미 주는 신호(status·token_expires_at·can_auto_refresh·
// last_error)에서 파생한다(Phase 0 post-status.ts와 같은 원칙 — 두 벌로 갈리는 판정을
// 만들지 않는다). PO 확定(story #3376 본문) — 파생 입력은 정확히 이 네 필드다.
//
// ⚠️'config_incomplete'(설정 미완)는 다섯 상태 어휘에는 있지만, 이 파생 함수의 네 입력
// 만으로는 만들어지지 않는다 — Phase 1이 구현하는 유일한 채널(Threads, PR#3736 본문
// "channel text NOT NULL -- threads(Phase1은 이거 하나만 구현)")은 credential_kind가
// 항상 'oauth'라 필수 org_config 값 개념 자체가 없다(연결이 되면 즉시 유효한 토큰이고,
// 안 되면 행 자체가 없어 '미연결'이다). 여섯 번째 축(missingRequiredFieldNames류)이
// 필요해지는 시점은 pasted_secret/설정값 채널이 추가될 때이고, 그때 이 파생 함수에
// 새 입력을 추가한다 — 지금 지어내지 않는다(Phase 0 SEAL_MISSING과 같은 "여섯 번째
// 상태를 만들지 않는다" 판단 축).
export type ChannelConnectionStatus =
  | 'not_connected'
  | 'config_incomplete'
  | 'connected'
  | 'expiring_soon'
  | 'reauth_required';

export type ChannelConnectionReauthReason = 'expired' | 'revoked' | 'error';

export interface ChannelConnectionStatusInput {
  /** 이 (channel, account) 연결 행 자체가 없으면 undefined — '미연결'. */
  serverStatus?: 'active' | 'expired' | 'revoked' | 'error';
  tokenExpiresAt?: string | null;
  canAutoRefresh?: boolean;
  lastError?: string | null;
  /** 만료 임박 판정 임계값(ms) — 테스트가 시각을 주입할 수 있게 now도 분리. */
  now?: Date;
  expiringSoonThresholdMs?: number;
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
    return { status: 'not_connected' };
  }
  if (input.serverStatus === 'expired') {
    return { status: 'reauth_required', reauthReason: 'expired' };
  }
  if (input.serverStatus === 'revoked') {
    return { status: 'reauth_required', reauthReason: 'revoked' };
  }
  if (input.serverStatus === 'error') {
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
};

export function channelConnectionStatusLabelKey(status: ChannelConnectionStatus): string {
  switch (status) {
    case 'not_connected': return 'channelStatusNotConnected';
    case 'config_incomplete': return 'channelStatusConfigIncomplete';
    case 'connected': return 'channelStatusConnected';
    case 'expiring_soon': return 'channelStatusExpiringSoon';
    case 'reauth_required': return 'channelStatusReauthRequired';
  }
}

// doc §8-1(유나) — 채널 행(여러 계정을 가질 수 있다, UNIQUE(org_id,channel,account_id))의
// 상태는 계정 중 최악으로 승격한다. 순서는 "얼마나 급한 할 일인가": 재인증 필요(이미 못
// 함) > 만료 임박(곧 못 함) > 설정 미완 > 연결됨 > 미연결(정보 없음이 가장 안 급하다).
const SEVERITY_ORDER: ChannelConnectionStatus[] = [
  'reauth_required', 'expiring_soon', 'config_incomplete', 'connected', 'not_connected',
];

export function worstChannelConnectionStatus(statuses: ChannelConnectionStatus[]): ChannelConnectionStatus {
  if (statuses.length === 0) return 'not_connected';
  for (const s of SEVERITY_ORDER) {
    if (statuses.includes(s)) return s;
  }
  return 'not_connected';
}
