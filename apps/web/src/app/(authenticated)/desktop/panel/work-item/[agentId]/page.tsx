import { WorkItemPanel } from '@/components/desktop-panel/work-item-panel';

/**
 * story 5042 (C9) — the work-item tab's page of the desktop app: `/desktop/panel/work-item/{agent id}`. The app's panel view loads exactly this address (the app builds it from a checked uuid); the shell draws it without the
 * web's own frame (components/desktop-panel/panel-path.ts).
 */
export default async function PanelWorkItemPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return <WorkItemPanel agentId={agentId} />;
}
