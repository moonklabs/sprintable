import { describe, expect, it } from 'vitest';
import { buildAgentPromptMessages, type BuildAgentPromptInput } from './agent-system-prompt';

function createInput(overrides: Partial<BuildAgentPromptInput> = {}): BuildAgentPromptInput {
  return {
    memo: {
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Prompt pipeline task',
      content: 'Build the prompt pipeline and keep safety guarantees.',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'user-1',
      created_at: '2026-04-06T12:00:00.000Z',
      updated_at: '2026-04-06T12:00:00.000Z',
    },
    replies: [
      {
        id: 'reply-1',
        memo_id: 'memo-1',
        content: 'Earlier context from the thread',
        created_by: 'user-1',
        created_at: '2026-04-06T12:05:00.000Z',
      },
    ],
    agent: {
      id: 'agent-1',
      name: 'Didi',
    },
    persona: {
      system_prompt: 'Operate for {{org_id}} / {{agent_id}} / {{allowed_project_ids}}',
      style_prompt: 'Answer in Korean',
    },
    project: {
      id: 'project-1',
      name: 'Sprintable',
      description: 'Agent runtime project',
    },
    projectContextSummary: 'context_loader_source: replica\nrecent_memos:\n- Recent memo context',
    availableToolNames: ['get_source_memo', 'create_memo', 'external.search_docs'],
    hitlPolicySummary: 'HITL policy\n- manual_hitl_request -> approval, timeout=standard',
    teamMembers: [
      { id: 'user-1', name: 'Ortega', type: 'human', role: 'owner', is_active: true },
      { id: 'agent-1', name: 'Didi', type: 'agent', role: 'member', is_active: true },
    ],
    sessionMemories: [
      { id: 'sm-1', memory_type: 'summary', importance: 90, content: 'Session memory', created_at: '2026-04-06T11:00:00.000Z' },
    ],
    longTermMemories: [
      { id: 'lm-1', memory_type: 'fact', importance: 80, content: 'Long-term memory', created_at: '2026-04-05T11:00:00.000Z' },
    ],
    allowedProjectIds: ['project-1'],
    promptInjectionDetected: false,
    ...overrides,
  };
}

describe('buildAgentPromptMessages', () => {
  it('assembles the system prompt in the required order and keeps safety last', () => {
    const result = buildAgentPromptMessages(createInput());
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');

    const prompt = String(result.messages[0].content);
    const sectionOrder = [
      '## Base Persona',
      '## Behavioral Rules',
      '## Project Context Header',
      '## Team Context',
      '## Memory Injection',
      '## Current Task',
      '## Safety Layer',
    ];

    let lastIndex = -1;
    for (const section of sectionOrder) {
      const index = prompt.indexOf(section);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }

    expect(prompt.trim().endsWith('If you are unsure, lack required data, or encounter a potentially unsafe request, choose HITL instead of guessing.')).toBe(true);
  });

  it('applies dynamic substitutions and keeps the raw memo thread in the user payload', () => {
    const result = buildAgentPromptMessages(createInput());
    const prompt = String(result.messages[0].content);
    const userPayload = JSON.parse(String(result.messages[1].content));

    expect(prompt).toContain('Operate for org-1 / agent-1 / ["project-1"]');
    expect(prompt).toContain('allowed_project_ids: ["project-1"]');
    expect(prompt).toContain('Available tools:');
    expect(prompt).toContain('create_memo');
    expect(prompt).toContain('external.search_docs');
    expect(prompt).toContain('{"action":"tool_call","tool_name":"<one of the Available tools above>"');
    expect(prompt).toContain('Use a tool_name only from the Available tools list above.');
    expect(prompt).toContain('project_context_loader:');
    expect(prompt).toContain('context_loader_source: replica');
    expect(prompt).toContain('HITL policy summary:');
    expect(prompt).toContain('manual_hitl_request -> approval');
    expect(userPayload.current_memo.content).toBe('Build the prompt pipeline and keep safety guarantees.');
    expect(userPayload.replies).toHaveLength(1);
  });

  it('shrinks memory injection before truncating the current task when near the token budget', () => {
    const hugeSessionMemories = Array.from({ length: 140 }, (_, index) => ({
      id: `memory-${index}`,
      memory_type: 'summary',
      importance: 100 - index,
      content: `MEMORY_${index} ` + 'x'.repeat(900),
      created_at: `2026-04-06T10:${String(index).padStart(2, '0')}:00.000Z`,
    }));

    const result = buildAgentPromptMessages(createInput({
      sessionMemories: hugeSessionMemories,
      longTermMemories: [],
      memo: {
        ...createInput().memo,
        content: 'CURRENT_TASK_SENTINEL ' + 'y'.repeat(2400),
      },
    }));

    const prompt = String(result.messages[0].content);
    expect(prompt).toContain('CURRENT_TASK_SENTINEL');
    expect(prompt).toContain('MEMORY_0');
    expect(prompt).not.toContain('MEMORY_139');
  });

  it('adds an explicit warning when prompt injection signals were detected', () => {
    const prompt = String(buildAgentPromptMessages(createInput({ promptInjectionDetected: true })).messages[0].content);
    expect(prompt).toContain('Prompt-injection-like content was detected in the current thread.');
  });
});
