// story 3436(묶음 6, 유나 어휘 정본 2026-09-05 03:56Z) — 채널 종류(raw string,
// BE 코드값/adapter display_name)가 사람이 읽는 문구에 그대로 새던 여러 자리(sandbox가
// "sandbox · Sandbox"로 겹쳐 보이던 것 등)를 한 맵으로 수렴. #3805
// CAMPAIGN_STATUS_LABEL_KEYS와 같은 형 — 모르는 값은 지어내지 않고 원문 그대로 폴백.
const CHANNEL_LABEL_KEYS: Record<string, string> = {
  threads: 'channelThreads',
  hosted_site: 'channelLabelHostedSite',
  wordpress: 'channelLabelWordpress',
  sandbox: 'channelLabelSandbox',
  // 디디 ④/⑤(#3800/#3802) 착지 뒤에야 실제로 들어오는 값 — 지금 develop엔 미등록이라
  // 당장은 아무 것도 이 키로 안 오지만, 죽은 키 스윕에서 지우지 말 것(의도된 선등록).
  webhook: 'channelLabelWebhook',
};

export function channelLabel(channel: string, t: (key: string) => string): string {
  const key = CHANNEL_LABEL_KEYS[channel];
  return key ? t(key) : channel;
}
