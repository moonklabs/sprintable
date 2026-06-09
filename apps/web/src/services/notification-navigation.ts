

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

    if (notification.reference_type === 'memo') {
      return { ...notification, href: `/memos?id=${referenceId}` };
    }

    if (notification.reference_type === 'task') {
      return { ...notification, href: '/boards' };
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

    return { ...notification, href: null };
  });
}
