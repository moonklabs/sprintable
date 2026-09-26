// story #4274(PO · 유나 스트리밍 대조) — 일감 프레임 경로는 로딩 경계가 탭 줄을 품는다(형제 탭 이동 때 탭 줄이 사라졌다 돌아오던 빈틈 제거).
// 부모 [ws]/[proj]/loading.tsx보다 이 파일이 가까운 경계라 우선한다.
import { WorkspaceFrameLoading } from '@/components/workspace/workspace-frame-loading';
import { SprintScreenPrefetchStarter } from '@/components/sprints/sprint-screen-prefetch-starter';

export default function Loading() {
  // story #4328 — 스프린트 화면 「하루 체크인」 요청을 누른 순간 먼저 출발(스프린트 목록과 같은 첫 물결).
  return (
    <>
      <SprintScreenPrefetchStarter />
      <WorkspaceFrameLoading />
    </>
  );
}
