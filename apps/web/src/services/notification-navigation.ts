import { withProjectParam } from '@/lib/with-project-param';

interface NotificationReference {
  reference_type: string | null;
  reference_id: string | null;
  // story #4244 — BE 목록 항목(NotificationListItem)이 싣는 대상(reference)의 프로젝트와 문서 slug(목록 조회 때 배치 해소 · 옛 행도 채워짐).
  // 조직 단위 대상 · 해소 불가(삭제 · 다른 조직 · 없는 대상)는 null. 표시·링크 전용.
  target_project_id?: string | null;
  target_doc_slug?: string | null;
}

/**
 * 알림 → 클릭 목적지. story #4244 — 링크는 **현재 프로젝트가 아니라 대상 자기 프로젝트**(`target_project_id`)를 `?p=`로 싣는다
 * (다른 프로젝트 게이트 알림을 열면 셸 = 현재 · 본문 = 게이트 프로젝트로 두 세계가 되던 결함 · 4241과 같은 규칙). 대상 프로젝트를 모르면
 * 주소 그대로(착지 뒤 셸이 정한다 — 틀린 p를 싣지 않는다). 문서 알림은 BE가 해소한 slug(`target_doc_slug`)로 그 문서를 연다(예전엔 slug
 * 조회용 db가 늘 undefined로 넘어와 항상 `/docs` 목록으로만 갔다).
 */
export function attachNotificationHrefs<T extends NotificationReference>(
  notifications: T[],
): Array<T & { href: string | null }> {
  return notifications.map((notification) => ({ ...notification, href: hrefForNotification(notification) }));
}

function hrefForNotification(notification: NotificationReference): string | null {
  const referenceId = notification.reference_id;
  if (!referenceId) return null;
  const p = notification.target_project_id ?? null;

  // story #2379 — '/memos' 라우트는 앱 어디에도 없다(인앱 reference_type='memo' 생성 콜사이트 0건) → 기본 fallback(href: null).
  switch (notification.reference_type) {
    // story a539c649 S3d — '/boards'(오탈자)+task_id 누락으로 항상 무효였던 링크를 getEntityHref와 동형(/board?task_id=)으로 정정.
    case 'task':
      return withProjectParam(`/board?task_id=${referenceId}`, p);
    case 'sprint':
      return withProjectParam('/sprints', p);
    // f2ec5395: story 참조 알림(status_changed 등) 클릭 내비(getEntityHref 동형).
    case 'story':
      return withProjectParam(`/board?story=${referenceId}`, p);
    case 'doc': {
      const slug = notification.target_doc_slug;
      return withProjectParam(slug ? `/docs/${slug}` : '/docs', p);
    }
    // doc_comment는 인앱 알림 생성 경로가 없다(BE 전수 · #4244) — 남은 옛 행은 문서 목록으로.
    case 'doc_comment':
      return withProjectParam('/docs', p);
    // story #0d1c69f3(v2 4호) — 게이트 알림은 /gates/[id] 상세로 직결. #4244 — 게이트 대상의 프로젝트를 싣는다.
    case 'gate':
      return withProjectParam(`/gates/${referenceId}`, p);
    default:
      return null;
  }
}
