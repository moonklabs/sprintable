import { buildAbsoluteMemoLink } from './app-url';

export interface DispatchableMemo {
  id: string;
  org_id: string;
  project_id: string;
  title: string | null;
  content: string;
  memo_type: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  metadata?: Record<string, unknown> | null;
  updated_at: string;
  created_at: string;
}

export async function dispatchMemoAssignmentImmediately(memo: DispatchableMemo) {
  if (!memo.assigned_to || memo.status !== 'open') return;

  try {
    const { createTeamMemberRepository } = await import('@/lib/storage/factory');
    const teamMemberRepo = await createTeamMemberRepository();
    const member = await teamMemberRepo.getById(memo.assigned_to).catch(() => null);
    if (!member?.webhook_url) return;

    const memoLabel = memo.title?.trim() ? `"${memo.title.trim()}"` : `#${memo.id.slice(0, 8)}`;
    const title = `📋 메모 배정: ${memoLabel}`;
    const preview = memo.content.replace(/\s+/g, ' ').trim().slice(0, 200);
    const memoLink = buildAbsoluteMemoLink(memo.id, process.env.NEXT_PUBLIC_APP_URL);
    const description = `${preview}\n\n${memoLink}`;

    const isDiscord = member.webhook_url.includes('discord.com') || member.webhook_url.includes('discordapp.com');
    const body = isDiscord
      ? JSON.stringify({ content: `${title}\n${description.substring(0, 500)}\n\nmemo_id: ${memo.id}` })
      : JSON.stringify({ text: `*${title}*\n${description}\n\nmemo_id: ${memo.id}` });

    await fetch(member.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // story #3644(3632 후속, 확認 선행) — 살아 있는 기능(메모 배정은 상시 사용 경로,
    // services/memo.ts:497이 매 메모 생성마다 호출)이라 은퇴 대상이 아니다. 다만 이
    // 웹훅은 배정 자체가 아니라 부가 알림(디스코드/슬랙 핑) — 메모 레코드는 이 함수
    // 호출 前에 이미 커밋·화면에서 정상 조회 가능하다. 실패해도 배정 자체를 조용히
    // "없음"으로 그리지 않으므로(doc §1 클래스 아님) console.warn으로 둔다.
    console.warn(
      '[MemoDispatch] assignment dispatch failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
