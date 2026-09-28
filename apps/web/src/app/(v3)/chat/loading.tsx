// story #4274(까디르 검수 P2) — v3 플래그를 켜면 탭 · 메뉴 목적지가 이 화면이 된다. 화면이 셸(사이드바 · 막대)을 스스로 그리므로 loading도 같은 셸 뼈대
// (V3ShellLoading) 안에, 이 화면의 내용 컨테이너 그대로 스켈레톤을 둔다(유나 «스켈레톤 = 페이지 컨테이너»). 이 폴더 layout의 redirect는
// 같은 폴더 loading 경계 바깥이라 오류 310과 무관.
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { V3ShellLoading } from '@/components/nav/v3-shell-loading';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
// 컨테이너: components/chat-v3/chat-v3-screen.tsx(막대 없음 · 내용 `flex flex-1 flex-col gap-3 p-5`).

export default function Loading() {
  return (
    <V3ShellLoading flags={readNavV3FlagsFromEnv()} activeKey="chats" topbar={false}>
      <PageSkeleton className="flex flex-1 flex-col gap-3 p-5" />
    </V3ShellLoading>
  );
}
