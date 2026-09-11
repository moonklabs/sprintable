// story 3436(묶음 6, 유나 어휘 정본 2026-09-05 03:56Z) — 채널 종류(raw string,
// BE 코드값/adapter display_name)가 사람이 읽는 문구에 그대로 새던 여러 자리(sandbox가
// "sandbox · Sandbox"로 겹쳐 보이던 것 등)를 한 맵으로 수렴. #3805
// CAMPAIGN_STATUS_LABEL_KEYS와 같은 형 — 모르는 값은 지어내지 않고 원문 그대로 폴백.
const CHANNEL_LABEL_KEYS: Record<string, string> = {
  threads: 'channelThreads',
  hosted_site: 'channelLabelHostedSite',
  wordpress: 'channelLabelWordpress',
  sandbox: 'channelLabelSandbox',
  // story #3523(BE #3872 착지, PO 確定 2026-09-06) — 등록 안 해도 크래시는 안 남(원문
  // "instagram"/"instagram_sandbox" 그대로 폴백, 위 주석의 "모르는 값은 지어내지 않고
  // 원문 그대로 폴백" 그 자체) — 다만 그 폴백이 화면에 실제로 뜨는 걸 막기 위해 등록.
  instagram: 'channelLabelInstagram',
  instagram_sandbox: 'channelLabelInstagramSandbox',
  // 디디 ④/⑤(#3800/#3802) 착지 뒤에야 실제로 들어오는 값 — 지금 develop엔 미등록이라
  // 당장은 아무 것도 이 키로 안 오지만, 죽은 키 스윕에서 지우지 말 것(의도된 선등록).
  webhook: 'channelLabelWebhook',
  // story #3549(3547 BE·디디 PR#3904 실측, 위 webhook과 동형 관례) — Facebook
  // Page 연결. 라벨 자체는 순수 FE 문구라 BE 계약과 무관하게 지금 등록해도 안전하다.
  facebook: 'channelLabelFacebook',
  // story #3549 REQUIRED 1(페드루 PO, 2026-09-06) — 실 Meta App Review 前엔 이
  // sandbox가 §13-8 라이브 검증의 유일한 길이라 facebook과 같이 선등록한다.
  facebook_sandbox: 'channelLabelFacebookSandbox',
  // story #3737(D3, 유나 定 2026-09-09) — 커넥터 화면(organization/connectors)
  // 섹션 제목이 connector_key를 그대로 뽑아 「stibee」가 raw로 떴다. channel_
  // connector_map.py 확인: stibee 커넥터는 channel===connector_key(항등 매핑) —
  // 이 맵에 얹는 게 안전(연결 화면과 커넥터 화면 둘 다 같은 표시명 정본 하나 재사용,
  // 새 낱말 0). ⚠️임시 처방 — 진짜 정본(커넥터 등록 자체가 display_name을 가짐)은
  // 다른 저장소(sprintable-agent-plugins의 *.schema.ts)에 있어 별건으로 남는다.
  stibee: 'channelLabelStibee',
  // story #3806 PR 7(페드루 PO 確定 2026-09-11) — meta_ads/ads_sandbox 행이 이 맵에
  // 없어 raw "meta_ads"/"ads_sandbox" 원문이 화면(행 제목·연결 버튼·owner-only 사유
  // 등 channelLabel() 전 소비처)에 그대로 새고 있던 결함 — PR1(#4172) 착지 뒤 FE가
  // 안 챙긴 것, 이번에 등록.
  meta_ads: 'channelLabelMetaAds',
  ads_sandbox: 'channelLabelAdsSandbox',
};

export function channelLabel(channel: string, t: (key: string) => string): string {
  const key = CHANNEL_LABEL_KEYS[channel];
  return key ? t(key) : channel;
}

// story #3743(UI 재설계 ③, 시안 a98386e6) — 행 목록의 표식(마크) 배경색. 순수 장식(사용자
// 데이터 아님)이라 "지어내지 않는다" 규율 밖 — 채널 공식 브랜드색(시안 캡처 값 그대로),
// 모르는 채널은 중립색 폴백(원문 텍스트를 지어내지 않는 channelLabel과 같은 fail-safe 축).
const CHANNEL_MARK_COLORS: Record<string, string> = {
  threads: '#121310',
  instagram: '#C13584',
  instagram_sandbox: '#C13584',
  facebook: '#1877F2',
  facebook_sandbox: '#5B6470',
  stibee: '#2E7D6B',
  wordpress: '#21759B',
  webhook: '#5B6470',
  hosted_site: '#3157FF',
  sandbox: '#5B6470',
};
const CHANNEL_MARK_NEUTRAL = '#5B6470';

export function channelMarkColor(channel: string): string {
  return CHANNEL_MARK_COLORS[channel] ?? CHANNEL_MARK_NEUTRAL;
}

// 표식 안 2글자 — 채널 키 자체(영문)에서 파생(번역 문구 아님, 사람이 읽는 텍스트가 아니라
// 아이콘 대용 이니셜이라 지어내지 않는다 규율 밖). `_sandbox` 접미는 벗겨 부모 채널과 같은
// 이니셜을 쓴다(사람은 이름 줄로 이미 구분, 표식은 브랜드 식별만).
export function channelMarkInitials(channel: string): string {
  const base = channel.replace(/_sandbox$/, '');
  return base.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

// story #3661(3650 후속, 유나 판정 정정 2026-09-07) — mismatch Alert 문장이 account_label
// null인 연결에서 account_id로 폴백했는데, webhook류는 그 값이 139자 URL이라 문장을
// 관통했다("무엇이 갱신됐는지"가 URL에 묻힘). 폴백은 «채널명 + 식별자 짧은 꼬리»로
// 정체는 남기고 자른다 — sha256 앞 8자(story #3641)와 같은 "짧은 꼬리" 관례, 연결
// 자신의 id(항상 UUID·URL이 아님)에서 뽑아 채널 종류와 무관하게 안전하다. 새 낱말 0
// (channelLabel 재사용).
export function channelConnectionIdentityLabel(
  conn: { id: string; channel: string; account_label: string | null }, t: (key: string) => string,
): string {
  return conn.account_label ?? `${channelLabel(conn.channel, t)}(…${conn.id.slice(-8)})`;
}
