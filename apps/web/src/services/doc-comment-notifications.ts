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

