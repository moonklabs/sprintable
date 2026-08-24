

interface NotificationReference {
  reference_type: string | null;
  reference_id: string | null;
}

interface DocCommentRow {
  id: string;
  doc_id: string;
}

interface DocRow {
  id: string;
  slug: string;
}

function buildDocHref(slug: string, commentId?: string) {
  return commentId ? `/docs/${slug}?commentId=${commentId}` : `/docs/${slug}`;
}

export async function attachNotificationHrefs<T extends NotificationReference>(
  db: any | undefined,
  notifications: T[],
): Promise<Array<T & { href: string | null }>> {
  const docCommentIds = notifications
    .filter((notification) => notification.reference_type === 'doc_comment' && notification.reference_id)
    .map((notification) => notification.reference_id as string);

  const docIds = notifications
    .filter((notification) => notification.reference_type === 'doc' && notification.reference_id)
    .map((notification) => notification.reference_id as string);

  let docComments: DocCommentRow[] = [];
  if (db && docCommentIds.length) {
    const { data, error } = await db
      .from('doc_comments')
      .select('id, doc_id')
      .in('id', docCommentIds);

    if (error) throw error;
    docComments = (data ?? []) as DocCommentRow[];
  }

  const allDocIds = [...new Set([...docIds, ...docComments.map((comment) => comment.doc_id)])];

  let docs: DocRow[] = [];
  if (db && allDocIds.length) {
    const { data, error } = await db
      .from('docs')
      .select('id, slug')
      .in('id', allDocIds);

    if (error) throw error;
    docs = (data ?? []) as DocRow[];
  }

  const docCommentMap = new Map(docComments.map((comment) => [comment.id, comment]));
  const docSlugMap = new Map(docs.map((doc) => [doc.id, doc.slug]));

  return notifications.map((notification) => {
    const referenceId = notification.reference_id;

    if (!referenceId) {
      return { ...notification, href: null };
    }

    // story #2379 — '/memos' 라우트는 앱 어디에도 없다(#2376 가드 실측, 죽은 링크). memo 기능
    // 자체는 SaaS에서 살아 있지만(memo-assignment-dispatch.ts·memo-reply-webhook-dispatch.ts가
    // 직접 webhook으로 발송), 인앱 notifications 테이블(reference_type='memo') 생성 콜사이트는
    // 0건이라(backend 전수 grep) 이 분기는 도달 불가였다. 지운 뒤엔 아래 기본 fallback(href:
    // null)으로 떨어진다 — 다른 미매치 reference_type과 동일한 처리라 새 결함이 아니다.

    if (notification.reference_type === 'task') {
      // story a539c649 S3d 그라운딩 중 발견: '/boards'(오탈자·복수형)+task_id 자체 누락이라
      // 이 알림 클릭 자체가 항상 무효였다(존재하지 않는 라우트+참조 ID 미실림). notification-bell.tsx
      // getEntityHref와 동형 패턴(/board?task_id=)으로 정정 — URL 이관과 무관한 별도 버그 fix.
      return { ...notification, href: `/board?task_id=${referenceId}` };
    }

    if (notification.reference_type === 'sprint') {
      return { ...notification, href: '/sprints' };
    }

    // f2ec5395: story 미처리 갭 — status_changed 등 story 참조 알림 클릭 내비(getEntityHref 동형).
    if (notification.reference_type === 'story') {
      return { ...notification, href: `/board?story=${referenceId}` };
    }

    if (notification.reference_type === 'doc') {
      const slug = docSlugMap.get(referenceId);
      return { ...notification, href: slug ? buildDocHref(slug) : '/docs' };
    }

    if (notification.reference_type === 'doc_comment') {
      const comment = docCommentMap.get(referenceId);
      if (!comment) return { ...notification, href: '/docs' };
      const slug = docSlugMap.get(comment.doc_id);
      return { ...notification, href: slug ? buildDocHref(slug, comment.id) : '/docs' };
    }

    // story #0d1c69f3(v2 4호) — 그룹 펼침의 항목별 CTA가 "죽은 링크 0"이려면 게이트 알림
    // (gate.pending_approval 등, reference_type='gate')에 실제 href가 있어야 한다. 지금까지
    // 이 분기가 없어 게이트 알림은 전부 href:null(클릭해도 아무 일도 안 일어남)이었다 —
    // /gates/[id] 상세 라우트(이미 존재, approval-request-card.tsx가 같은 라우트로 fetch)로
    // 직결한다. DB 조회 불필요(reference_id를 그대로 경로에 싣는다).
    if (notification.reference_type === 'gate') {
      return { ...notification, href: `/gates/${referenceId}` };
    }

    return { ...notification, href: null };
  });
}
