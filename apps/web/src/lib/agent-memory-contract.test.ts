import { describe, expect, it } from 'vitest';
import {
  createContinuityDebugInfo,
  createSessionMemoryWrite,
  getMemoryCompactionPolicy,
  partitionLongTermMemoryRowsByScope,
  partitionSessionMemoryRowsByScope,
  selectMemoriesForCompaction,
} from './agent-memory-contract';

describe('agent-memory-contract', () => {
  it('builds session memory writes with explicit project scope', () => {
    expect(createSessionMemoryWrite({
      scope: {
        orgId: 'org-1',
        projectId: 'project-1',
        agentId: 'agent-1',
        sessionId: 'session-1',
      },
      runId: 'run-1',
      memoryType: 'summary',
      content: 'remember this',
      metadata: { memo_id: 'memo-1' },
    })).toEqual({
      org_id: 'org-1',
      project_id: 'project-1',
      agent_id: 'agent-1',
      session_id: 'session-1',
      run_id: 'run-1',
      memory_type: 'summary',
      importance: undefined,
      content: 'remember this',
      metadata: { memo_id: 'memo-1' },
    });
  });

  it('partitions session memories by org, project, agent, and session scope', () => {
    const result = partitionSessionMemoryRowsByScope([
      { id: 'in-scope', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', session_id: 'session-1' },
      { id: 'other-project', org_id: 'org-1', project_id: 'project-2', agent_id: 'agent-1', session_id: 'session-1' },
      { id: 'other-session', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', session_id: 'session-2' },
    ], {
      orgId: 'org-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });

    expect(result.inScope.map((row) => row.id)).toEqual(['in-scope']);
    expect(result.outOfScope.map((row) => row.id)).toEqual(['other-project', 'other-session']);
  });

  it('partitions long-term memories by org, project, and agent scope', () => {
    const result = partitionLongTermMemoryRowsByScope([
      { id: 'in-scope', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1' },
      { id: 'other-agent', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-2' },
      { id: 'other-project', org_id: 'org-1', project_id: 'project-2', agent_id: 'agent-1' },
    ], {
      orgId: 'org-1',
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    expect(result.inScope.map((row) => row.id)).toEqual(['in-scope']);
    expect(result.outOfScope.map((row) => row.id)).toEqual(['other-agent', 'other-project']);
  });

  it('returns explicit compaction policy criteria and verdicts', () => {
    const policy = getMemoryCompactionPolicy();
    expect(policy.keepCriteria).toContain('Keep memories with importance >= 20.');
    expect(policy.deleteCriteria).toContain('Delete lower-ranked memories once the per-type quota is exceeded.');
    expect(policy.typeQuota.summary).toBe(4);

    const verdicts = selectMemoriesForCompaction([
      {
        id: 'keep-1',
        memory_type: 'summary',
        importance: 90,
        content: 'Stable deployment rule',
        created_at: '2026-04-10T00:00:00.000Z',
      },
      {
        id: 'drop-1',
        memory_type: 'summary',
        importance: 10,
        content: 'Old noisy detail',
        created_at: '2026-04-01T00:00:00.000Z',
      },
    ], '2026-04-13T00:00:00.000Z');

    expect(verdicts).toEqual([
      expect.objectContaining({ id: 'keep-1', verdict: 'keep', rule: 'passes_all' }),
      expect.objectContaining({ id: 'drop-1', verdict: 'delete', rule: 'low_importance' }),
    ]);
  });

  it('builds continuity debug info from scoped snapshot metadata', () => {
    expect(createContinuityDebugInfo({
      sessionId: 'session-1',
      contextSnapshot: { memories: [{ content: 'Scoped memory' }] },
      restoredMemoryCount: 1,
      memoryRetrievalDiagnostics: {
        session: { queriedCount: 2, inScopeCount: 1, blockedCount: 1, injectedIds: ['sm-1'] },
        longTerm: { queriedCount: 1, inScopeCount: 1, blockedCount: 0, injectedIds: ['lm-1'] },
        totalInjected: 2,
        droppedByTokenBudget: 0,
      },
    })).toEqual({
      sessionId: 'session-1',
      snapshotPresent: true,
      snapshotMemoryCount: 1,
      restoredFromSnapshot: true,
      memoryRetrievalDiagnostics: {
        session: { queriedCount: 2, inScopeCount: 1, blockedCount: 1, injectedIds: ['sm-1'] },
        longTerm: { queriedCount: 1, inScopeCount: 1, blockedCount: 0, injectedIds: ['lm-1'] },
        totalInjected: 2,
        droppedByTokenBudget: 0,
      },
    });
  });
});
