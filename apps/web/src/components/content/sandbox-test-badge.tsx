import { useTranslations } from 'next-intl';

// story f30da19a AC5(유나 확定 2026-09-04 11:17Z ②·페드루 PO 파생) — sandbox 연결로
// 만든 초안은 실제 채널로 절대 안 나가는 테스트 글이다. 진짜 초안과 나란히 서는 표면
// (목록 T1·상세 머리 T3·캘린더 칸 T8) 전부에서 같은 표기를 써야 승인·발행 게이트를
// 실수로 통과시키지 않는다. §17-1 오버레이 규율 — 상태 칩은 그대로, 이 배지를 얹는다.
// 표기는 색이 아니라 «글자»로 전달한다(색각·의미 전달, 유나 확定 ②) — 배경색 신호에
// 의존하지 않고 무채 테두리+텍스트로만 구별한다.
export function isSandboxChannelDraft(channel: string | null | undefined): boolean {
  return channel === 'sandbox';
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
