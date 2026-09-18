import { useTranslations } from 'next-intl';

// story f30da19a AC5(유나 확定 2026-09-04 11:17Z ②·페드루 PO 파생) — sandbox 연결로
// 만든 초안은 실제 채널로 절대 안 나가는 테스트 글이다. 진짜 초안과 나란히 서는 표면
// (목록 T1·상세 머리 T3·캘린더 칸 T8) 전부에서 같은 표기를 써야 승인·발행 게이트를
// 실수로 통과시키지 않는다. §17-1 오버레이 규율 — 상태 칩은 그대로, 이 배지를 얹는다.
// 표기는 색이 아니라 «글자»로 전달한다(색각·의미 전달, 유나 확定 ②) — 배경색 신호에
// 의존하지 않고 무채 테두리+텍스트로만 구별한다.
// story #4009(critical, 페드루 PO 確定 2026-09-17) — 이전엔 'sandbox' 한 키만 봐서
// instagram_sandbox/facebook_sandbox/ads_sandbox/x_sandbox/youtube_sandbox/
// stibee_sandbox/ghost_sandbox 7개가 이 배지를 못 받았다. ⚠️정확한 표현 — 이
// 함수는 백엔드 `is_test_channel` 속성을 직접 읽지 않는다(이 훅이 받는 건 채널
// 문자열뿐, 라운드트립 없음) — 채널 이름의 `_sandbox` 접미(또는 단독 `sandbox`)
// **명명 관례**를 읽는다. 이 관례가 백엔드 `is_test_channel` 선언과 항상 일치
// 한다는 것은 `test_5b27b32f_sandbox_channel.py::
// test_test_channel_registration_matches_naming_convention_both_directions`가
// `CHANNEL_ADAPTERS` 전체를 순회하며 양방향으로 강제한다(이름 한 키 비교 0,
// 새 sandbox 채널이 이 관례를 벗어나면 그 가드가 잡는다).
export function isSandboxChannelDraft(channel: string | null | undefined): boolean {
  return channel === 'sandbox' || (channel ?? '').endsWith('_sandbox');
}

export function SandboxTestBadge() {
  const t = useTranslations('content');
  return (
    <span
      className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
      data-testid="channel-post-sandbox-test-badge"
    >
      {t('channelPostsSandboxTestBadge')}
    </span>
  );
}
