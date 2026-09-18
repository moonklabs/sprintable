/**
 * story #3805(Phase3·3-1·PR 4 후속, 유나 判定 2026-09-11 12:48Z — page.tsx 밖으로
 * 뽑아낸 순수 함수. Next.js route 파일(page.tsx)은 default export 외 이름 있는
 * export를 테스트용으로 늘리지 않는 관례라(다른 route 파일과 동형) 별도 유틸
 * 파일로 분리 — comments-section.tsx::deriveCommentsFace와 같은 「순수 로직은
 * 따로 빼서 마운트 없이 테스트」 패턴.
 *
 * 정정 배경: 「답글 구분 불가」(reply_detection_unavailable)를 「수집 안 됨」
 * (last_collected_at=null) 상태에도 붙이면 「한 번도 수집 안 됐는데 응답에
 * 부모 정보가 없었다」는 모순 문장이 된다(그 연결은 애초에 응답 자체를 받은 적이
 * 없다) — «최소 한 번은 수집에 성공한» 상태(`last_collected_at` 有)에만 이
 * 문구를 붙인다.
 */
export function shouldShowReplyDetectionUnavailable(item: {
  reply_detection_unavailable: boolean;
  last_collected_at: string | null;
}): boolean {
  return item.reply_detection_unavailable && item.last_collected_at !== null;
}
