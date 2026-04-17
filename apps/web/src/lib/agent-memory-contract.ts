export type AgentMemoryType = 'context' | 'summary' | 'decision' | 'todo' | 'fact';

export interface AgentMemoryProjectScope {
  orgId: string;
  projectId: string;
  agentId: string;
}

export interface AgentSessionMemoryScope extends AgentMemoryProjectScope {
  sessionId: string;
}

export interface AgentSessionMemoryScopeRow {
  org_id?: string | null;
  project_id?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
}

export interface AgentLongTermMemoryScopeRow {
  org_id?: string | null;
  project_id?: string | null;
  agent_id?: string | null;
}

export function createSessionMemoryWrite(input: {
  scope: AgentSessionMemoryScope;
  runId: string | null;
  memoryType: AgentMemoryType;
  content: string;
  importance?: number;
  metadata?: Record<string, unknown>;
}) {
  return {
    org_id: input.scope.orgId,
    project_id: input.scope.projectId,
    agent_id: input.scope.agentId,
    session_id: input.scope.sessionId,
    run_id: input.runId,
    memory_type: input.memoryType,
    importance: input.importance,
    content: input.content,
    metadata: input.metadata ?? {},
  };
}

export function isSessionMemoryInScope(
  row: AgentSessionMemoryScopeRow,
  scope: AgentSessionMemoryScope,
): boolean {
  return row.org_id === scope.orgId
    && row.project_id === scope.projectId
    && row.agent_id === scope.agentId
    && row.session_id === scope.sessionId;
}

export function isLongTermMemoryInScope(
  row: AgentLongTermMemoryScopeRow,
  scope: AgentMemoryProjectScope,
): boolean {
  return row.org_id === scope.orgId
    && row.project_id === scope.projectId
    && row.agent_id === scope.agentId;
}

export function partitionSessionMemoryRowsByScope<T extends AgentSessionMemoryScopeRow>(
  rows: T[],
  scope: AgentSessionMemoryScope,
): { inScope: T[]; outOfScope: T[] } {
  const inScope: T[] = [];
  const outOfScope: T[] = [];

  for (const row of rows) {
    if (isSessionMemoryInScope(row, scope)) {
      inScope.push(row);
    } else {
      outOfScope.push(row);
    }
  }

  return { inScope, outOfScope };
}

export function partitionLongTermMemoryRowsByScope<T extends AgentLongTermMemoryScopeRow>(
  rows: T[],
  scope: AgentMemoryProjectScope,
): { inScope: T[]; outOfScope: T[] } {
  const inScope: T[] = [];
  const outOfScope: T[] = [];

  for (const row of rows) {
    if (isLongTermMemoryInScope(row, scope)) {
      inScope.push(row);
    } else {
      outOfScope.push(row);
    }
  }

  return { inScope, outOfScope };
}

// ---------------------------------------------------------------------------
// Memory retrieval diagnostics
// ---------------------------------------------------------------------------

export interface MemoryRetrievalDiagnostics {
  session: MemoryRetrievalBucket;
  longTerm: MemoryRetrievalBucket;
  totalInjected: number;
  droppedByTokenBudget: number;
}

export interface MemoryRetrievalBucket {
  queriedCount: number;
  inScopeCount: number;
  blockedCount: number;
  injectedIds: string[];
}

export function createEmptyRetrievalDiagnostics(): MemoryRetrievalDiagnostics {
  return {
    session: { queriedCount: 0, inScopeCount: 0, blockedCount: 0, injectedIds: [] },
    longTerm: { queriedCount: 0, inScopeCount: 0, blockedCount: 0, injectedIds: [] },
    totalInjected: 0,
    droppedByTokenBudget: 0,
  };
}

// ---------------------------------------------------------------------------
// Compaction criteria
// ---------------------------------------------------------------------------

export interface CompactionCandidate {
  id: string;
  memory_type: AgentMemoryType;
  importance: number;
  content: string;
  created_at: string;
}

export type CompactionVerdict = 'keep' | 'delete';

export interface CompactionRule {
  name: string;
  verdict: CompactionVerdict;
  reason: string;
}

export interface CompactionResult {
  id: string;
  verdict: CompactionVerdict;
  rule: string;
  reason: string;
}

const COMPACTION_MIN_IMPORTANCE = 20;
const COMPACTION_MAX_AGE_DAYS = 30;
const COMPACTION_DUPLICATE_SIMILARITY = 0.85;
const COMPACTION_TYPE_QUOTA: Record<AgentMemoryType, number> = {
  context: 3,
  summary: 4,
  decision: 3,
  todo: 2,
  fact: 4,
};

export interface MemoryCompactionPolicy {
  keepCriteria: string[];
  deleteCriteria: string[];
  typeQuota: Record<AgentMemoryType, number>;
  thresholds: {
    minImportance: number;
    maxAgeDays: number;
    duplicateSimilarity: number;
  };
}

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeForComparison(a).split(' '));
  const wordsB = new Set(normalizeForComparison(b).split(' '));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function evaluateCompaction(
  candidate: CompactionCandidate,
  peers: CompactionCandidate[],
  nowIso: string,
): CompactionResult {
  const now = new Date(nowIso).getTime();
  const created = new Date(candidate.created_at).getTime();
  const ageDays = (now - created) / (1000 * 60 * 60 * 24);

  if (candidate.importance < COMPACTION_MIN_IMPORTANCE) {
    return { id: candidate.id, verdict: 'delete', rule: 'low_importance', reason: `importance ${candidate.importance} < ${COMPACTION_MIN_IMPORTANCE}` };
  }

  if (ageDays > COMPACTION_MAX_AGE_DAYS && candidate.importance < 50) {
    return { id: candidate.id, verdict: 'delete', rule: 'stale_low_value', reason: `age ${Math.round(ageDays)}d > ${COMPACTION_MAX_AGE_DAYS}d with importance ${candidate.importance} < 50` };
  }

  for (const peer of peers) {
    if (peer.id === candidate.id) continue;
    if (peer.importance <= candidate.importance) continue;
    const sim = jaccardSimilarity(candidate.content, peer.content);
    if (sim >= COMPACTION_DUPLICATE_SIMILARITY) {
      return { id: candidate.id, verdict: 'delete', rule: 'near_duplicate', reason: `${(sim * 100).toFixed(0)}% similar to ${peer.id} (higher importance ${peer.importance})` };
    }
  }

  const sameType = peers.filter((p) => p.memory_type === candidate.memory_type);
  const quota = COMPACTION_TYPE_QUOTA[candidate.memory_type] ?? 3;
  const higherRanked = sameType.filter((p) => p.id !== candidate.id && (p.importance > candidate.importance || (p.importance === candidate.importance && p.created_at > candidate.created_at)));
  if (higherRanked.length >= quota) {
    return { id: candidate.id, verdict: 'delete', rule: 'type_quota_exceeded', reason: `${higherRanked.length} higher-ranked ${candidate.memory_type} memories exceed quota of ${quota}` };
  }

  return { id: candidate.id, verdict: 'keep', rule: 'passes_all', reason: 'meets importance, recency, uniqueness, and type quota criteria' };
}

export function selectMemoriesForCompaction(
  candidates: CompactionCandidate[],
  nowIso: string,
): CompactionResult[] {
  return candidates.map((c) => evaluateCompaction(c, candidates, nowIso));
}

export function getMemoryCompactionPolicy(): MemoryCompactionPolicy {
  return {
    keepCriteria: [
      `Keep memories with importance >= ${COMPACTION_MIN_IMPORTANCE}.`,
      `Keep older memories when importance >= 50, even if older than ${COMPACTION_MAX_AGE_DAYS} days.`,
      `Keep memories that are not near-duplicates of a higher-importance peer (similarity < ${COMPACTION_DUPLICATE_SIMILARITY}).`,
      'Keep top-ranked memories within the per-type quota after sorting by importance and recency.',
    ],
    deleteCriteria: [
      `Delete memories with importance < ${COMPACTION_MIN_IMPORTANCE}.`,
      `Delete memories older than ${COMPACTION_MAX_AGE_DAYS} days when importance < 50.`,
      `Delete near-duplicate memories when similarity >= ${COMPACTION_DUPLICATE_SIMILARITY} and a higher-importance peer exists.`,
      'Delete lower-ranked memories once the per-type quota is exceeded.',
    ],
    typeQuota: { ...COMPACTION_TYPE_QUOTA },
    thresholds: {
      minImportance: COMPACTION_MIN_IMPORTANCE,
      maxAgeDays: COMPACTION_MAX_AGE_DAYS,
      duplicateSimilarity: COMPACTION_DUPLICATE_SIMILARITY,
    },
  };
}

// ---------------------------------------------------------------------------
// Continuity debug diagnostics
// ---------------------------------------------------------------------------

export interface ContinuityDebugInfo {
  sessionId: string | null;
  snapshotPresent: boolean;
  snapshotMemoryCount: number;
  restoredFromSnapshot: boolean;
  memoryRetrievalDiagnostics: MemoryRetrievalDiagnostics | null;
}

export function createContinuityDebugInfo(input: {
  sessionId: string | null;
  contextSnapshot: Record<string, unknown> | null;
  restoredMemoryCount?: number | null;
  memoryRetrievalDiagnostics: MemoryRetrievalDiagnostics | null;
}): ContinuityDebugInfo {
  const snapshot = input.contextSnapshot;
  const snapshotMemories = Array.isArray(snapshot?.['memories']) ? snapshot['memories'] : [];

  return {
    sessionId: input.sessionId,
    snapshotPresent: Boolean(snapshot),
    snapshotMemoryCount: snapshotMemories.length,
    restoredFromSnapshot: (input.restoredMemoryCount ?? 0) > 0,
    memoryRetrievalDiagnostics: input.memoryRetrievalDiagnostics,
  };
}
