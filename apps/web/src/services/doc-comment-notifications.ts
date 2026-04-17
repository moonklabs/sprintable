import type { SupabaseClient } from '@supabase/supabase-js';

export interface MentionableProjectMember {
  id: string;
  name: string;
  user_id: string | null;
  type: string;
  is_active: boolean | null;
}

function isMentionPrefixBoundary(char: string | undefined) {
  return !char || /[\s([{<'"“‘]/u.test(char);
}

function isMentionSuffixBoundary(char: string | undefined) {
  return !char || /[\s)\]}>,'"”’.!?;:]/u.test(char);
}

export function hasExactMemberMention(content: string, memberName: string) {
  if (!content || !memberName) return false;

  const mentionToken = `@${memberName}`;
  let index = content.indexOf(mentionToken);

  while (index !== -1) {
    const prefix = index > 0 ? content[index - 1] : undefined;
    const suffixIndex = index + mentionToken.length;
    const suffix = suffixIndex < content.length ? content[suffixIndex] : undefined;

    if (isMentionPrefixBoundary(prefix) && isMentionSuffixBoundary(suffix)) {
      return true;
    }

    index = content.indexOf(mentionToken, index + mentionToken.length);
  }

  return false;
}

export function findMentionedProjectMembers(
  content: string,
  members: MentionableProjectMember[],
  authorId?: string,
) {
  return members.filter((member) => (
    member.id !== authorId
    && member.type === 'human'
    && member.is_active === true
    && Boolean(member.user_id)
    && hasExactMemberMention(content, member.name)
  ));
}

function buildDocCommentNotificationBody(docTitle: string, content: string) {
  const snippet = content.trim().replace(/\s+/g, ' ');
  if (!snippet) return `"${docTitle}" 문서 댓글에서 멘션되었습니다.`;
  return `"${docTitle}" 문서 댓글: ${snippet.slice(0, 120)}${snippet.length > 120 ? '…' : ''}`;
}

interface NotifyDocCommentMentionsInput {
  sourceSupabase: SupabaseClient;
  adminSupabase: SupabaseClient;
  docId: string;
  commentId: string;
  content: string;
  authorId: string;
}

export async function notifyDocCommentMentions({
  sourceSupabase,
  adminSupabase,
  docId,
  commentId,
  content,
  authorId,
}: NotifyDocCommentMentionsInput) {
  const { data: doc, error: docError } = await sourceSupabase
    .from('docs')
    .select('id, org_id, project_id, title, deleted_at')
    .eq('id', docId)
    .maybeSingle();

  if (docError) throw docError;
  if (!doc || doc.deleted_at) return 0;

  const { data: members, error: membersError } = await sourceSupabase
    .from('team_members')
    .select('id, name, user_id, type, is_active')
    .eq('org_id', doc.org_id)
    .eq('project_id', doc.project_id)
    .eq('type', 'human')
    .eq('is_active', true);

  if (membersError) throw membersError;

  const mentionedMembers = findMentionedProjectMembers(content, (members ?? []) as MentionableProjectMember[], authorId);
  if (!mentionedMembers.length) return 0;

  const notifications = mentionedMembers.map((member) => ({
    org_id: doc.org_id,
    user_id: member.id,
    type: 'info',
    title: '문서 댓글 멘션',
    body: buildDocCommentNotificationBody(doc.title, content),
    reference_type: 'doc_comment',
    reference_id: commentId,
  }));

  const { error } = await adminSupabase.from('notifications').insert(notifications);
  if (error) throw error;

  return notifications.length;
}
