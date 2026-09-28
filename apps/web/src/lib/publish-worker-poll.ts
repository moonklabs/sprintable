// story #4336 — 발행은 워커(cron)가 돌린다. «발행 중» · 컨테이너 대기인 동안 화면(채널 초안 상세 · 외부 발행 게이트 상세)이 다시 읽는 간격 —
// 한 곳에 둬 두 화면이 같은 간격으로 결과로 넘어간다.
export const PUBLISH_WORKER_POLL_MS = 5000;

/** 서버의 `processing_kind`(BE `derive_processing_kind` 한 판정)가 워커를 기다리는 값인가. */
export function isAwaitingPublishWorker(processingKind: string | null | undefined): boolean {
  return processingKind === 'publishing' || processingKind === 'awaiting_container';
}
