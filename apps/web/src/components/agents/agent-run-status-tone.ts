import type { ChipProps } from '@/components/ds/chip';
import { agentRunStatusBadgeVariant, type AgentRunStatus, type AgentRunStatusBadgeVariant } from '@/lib/agent-run-status';

/**
 * story 4911 — the status chip's tone. The status → face fact is said ONCE, in the catalog (`lib/agent-run-status.ts`, story 3689); this screen only translates the catalog's badge variant into the ds Chip's tone
 * (the Chip has no «warning»: an unfinished (`abandoned`) run is one a person should look at → `needs-hand`; the word is always written, so the colour never speaks alone).
 * Only a MEANING gets a colour (failed · waiting on a person · done · live); `queued` / `held` and the unknown stay neutral. A person-wait (`hitl_pending`) is `needs-hand` whatever the catalog's shared variant says.
 */
const VARIANT_TONE: Record<AgentRunStatusBadgeVariant, NonNullable<ChipProps['tone']>> = {
  success: 'done',
  destructive: 'failed',
  info: 'info',
  outline: 'neutral',
  secondary: 'neutral',
  warning: 'needs-hand',
};
export const statusTone = (status: AgentRunStatus): NonNullable<ChipProps['tone']> =>
  status === 'hitl_pending' ? 'needs-hand' : VARIANT_TONE[agentRunStatusBadgeVariant(status)];
