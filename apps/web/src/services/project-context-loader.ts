import { createAdminClient } from '@/lib/db/admin';
import type { PromptProjectRecord, PromptTeamMemberRecord } from './agent-system-prompt';

export interface ProjectContextLoaderOptions {
  readClient?: any;
  timeoutMs?: number;
  recentMemoLimit?: number;
  openEpicLimit?: number;
  openStoryLimit?: number;
}

interface ProjectContextMemoRow {
  id: string;
  title: string | null;
  content: string;
  memo_type: string;
  status: string;
  updated_at: string;
}

interface ProjectContextEpicRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  updated_at: string;
}

interface ProjectContextStoryRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  updated_at: string;
}

export interface LoadedProjectContext {
  project: PromptProjectRecord | null;
  teamMembers: PromptTeamMemberRecord[];
  summary: string;
  meta: {
    source: 'replica' | 'primary';
    usedFallback: boolean;
    timedOut: boolean;
    tokenCount: number;
  };
}

const PROJECT_CONTEXT_TOKEN_BUDGET = 2048;
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_RECENT_MEMO_LIMIT = 5;
const DEFAULT_OPEN_EPIC_LIMIT = 5;
const DEFAULT_OPEN_STORY_LIMIT = 8;
const REQUIRED_OVERVIEW_HEADROOM_TOKENS = 64;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]'],
  [/\bAIza[0-9A-Za-z\-_]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/([?&](?:token|key|secret|sig|signature)=)[^&#\s]+/gi, '$1[REDACTED]'],
  [/(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*["']?[^"'\s,&]+/gi, '$1=[REDACTED]'],
];

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function redactSecrets(text: string | null | undefined): string {
  if (!text) return '';
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function createOverview(project: PromptProjectRecord | null, source: 'replica' | 'primary', usedFallback: boolean): string[] {
  return [
    `project_name: ${project?.name ?? '(unknown project)'}`,
    `project_description: ${truncateText(redactSecrets(project?.description ?? '(none)'), 400)}`,
    `context_loader_source: ${source}`,
    `context_loader_fallback: ${usedFallback ? 'true' : 'false'}`,
  ];
}

function renderSection(title: string, lines: string[]): string {
  return `${title}:\n${lines.length ? lines.join('\n') : '- (none)'}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('project_context_loader_timeout')), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function createProjectContextReplicaClient(): any | null {
  // 레플리카 클라이언트는 사용하지 않음
  return null;
}

export class ProjectContextLoader {
  private readonly readClient: any;
  private readonly timeoutMs: number;
  private readonly recentMemoLimit: number;
  private readonly openEpicLimit: number;
  private readonly openStoryLimit: number;

  constructor(
    private readonly primaryClient: any,
    options: ProjectContextLoaderOptions = {},
  ) {
    this.readClient = options.readClient ?? createProjectContextReplicaClient() ?? primaryClient;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.recentMemoLimit = options.recentMemoLimit ?? DEFAULT_RECENT_MEMO_LIMIT;
    this.openEpicLimit = options.openEpicLimit ?? DEFAULT_OPEN_EPIC_LIMIT;
    this.openStoryLimit = options.openStoryLimit ?? DEFAULT_OPEN_STORY_LIMIT;
  }

  async load(scope: { orgId: string; projectId: string; agentId: string }): Promise<LoadedProjectContext> {
    try {
      const detailed = await withTimeout(this.loadDetailed(this.readClient, scope), this.timeoutMs);
      return this.buildContextSnapshot(detailed, this.readClient === this.primaryClient ? 'primary' : 'replica', false, false);
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'project_context_loader_timeout';
      const fallback = await this.loadFallback(scope);
      return this.buildContextSnapshot(fallback, 'primary', true, timedOut);
    }
  }

  private async loadDetailed(client: any, scope: { orgId: string; projectId: string; agentId: string }) {
    const [projectResult, teamMembersResult, memosResult, epicsResult, storiesResult] = await Promise.all([
      client
        .from('projects')
        .select('id, name, description')
        .eq('org_id', scope.orgId)
        .eq('id', scope.projectId)
        .is('deleted_at', null)
        .maybeSingle(),
      client
        .from('team_members')
        .select('id, name, type, role, is_active')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .is('deleted_at', null)
        .order('type', { ascending: true })
        .order('name', { ascending: true }),
      client
        .from('memos')
        .select('id, title, content, memo_type, status, updated_at')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(this.recentMemoLimit),
      client
        .from('epics')
        .select('id, title, status, priority, description, updated_at')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .is('deleted_at', null)
        .neq('status', 'done')
        .order('updated_at', { ascending: false })
        .limit(this.openEpicLimit),
      client
        .from('stories')
        .select('id, title, status, priority, description, updated_at')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .is('deleted_at', null)
        .neq('status', 'done')
        .order('updated_at', { ascending: false })
        .limit(this.openStoryLimit),
    ]);

    if (projectResult.error) throw projectResult.error;
    if (teamMembersResult.error) throw teamMembersResult.error;
    if (memosResult.error) throw memosResult.error;
    if (epicsResult.error) throw epicsResult.error;
    if (storiesResult.error) throw storiesResult.error;

    return {
      project: (projectResult.data as PromptProjectRecord | null) ?? null,
      teamMembers: (teamMembersResult.data ?? []) as PromptTeamMemberRecord[],
      recentMemos: (memosResult.data ?? []) as ProjectContextMemoRow[],
      openEpics: (epicsResult.data ?? []) as ProjectContextEpicRow[],
      openStories: (storiesResult.data ?? []) as ProjectContextStoryRow[],
    };
  }

  private async loadFallback(scope: { orgId: string; projectId: string; agentId: string }) {
    const [projectResult, teamMembersResult] = await Promise.all([
      this.primaryClient
        .from('projects')
        .select('id, name, description')
        .eq('org_id', scope.orgId)
        .eq('id', scope.projectId)
        .is('deleted_at', null)
        .maybeSingle(),
      this.primaryClient
        .from('team_members')
        .select('id, name, type, role, is_active')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .is('deleted_at', null)
        .order('type', { ascending: true })
        .order('name', { ascending: true }),
    ]);

    if (projectResult.error) throw projectResult.error;
    if (teamMembersResult.error) throw teamMembersResult.error;

    return {
      project: (projectResult.data as PromptProjectRecord | null) ?? null,
      teamMembers: (teamMembersResult.data ?? []) as PromptTeamMemberRecord[],
      recentMemos: [] as ProjectContextMemoRow[],
      openEpics: [] as ProjectContextEpicRow[],
      openStories: [] as ProjectContextStoryRow[],
    };
  }

  private buildContextSnapshot(
    data: {
      project: PromptProjectRecord | null;
      teamMembers: PromptTeamMemberRecord[];
      recentMemos: ProjectContextMemoRow[];
      openEpics: ProjectContextEpicRow[];
      openStories: ProjectContextStoryRow[];
    },
    source: 'replica' | 'primary',
    usedFallback: boolean,
    timedOut: boolean,
  ): LoadedProjectContext {
    const sanitizedProject = data.project
      ? {
          ...data.project,
          description: redactSecrets(data.project.description),
        }
      : null;

    const memoLines = data.recentMemos.map((memo) =>
      `- ${memo.updated_at} [${memo.status}/${memo.memo_type}] ${memo.title ?? '(untitled memo)'} :: ${truncateText(redactSecrets(memo.content), 180)}`,
    );
    const epicLines = data.openEpics.map((epic) =>
      `- [${epic.status}/${epic.priority}] ${epic.title} :: ${truncateText(redactSecrets(epic.description ?? '(no description)'), 140)}`,
    );
    const storyLines = data.openStories.map((story) =>
      `- [${story.status}/${story.priority}] ${story.title} :: ${truncateText(redactSecrets(story.description ?? '(no description)'), 140)}`,
    );

    const overviewLines = createOverview(sanitizedProject, source, usedFallback);
    const sections = {
      memos: [...memoLines],
      epics: [...epicLines],
      stories: [...storyLines],
    };

    const buildSummary = () => [
      ...overviewLines,
      renderSection('recent_memos', sections.memos),
      renderSection('open_epics', sections.epics),
      renderSection('open_stories', sections.stories),
    ].join('\n');

    let summary = buildSummary();

    while (estimateTokens(summary) > PROJECT_CONTEXT_TOKEN_BUDGET && sections.memos.length > 1) {
      sections.memos.pop();
      summary = buildSummary();
    }

    while (estimateTokens(summary) > PROJECT_CONTEXT_TOKEN_BUDGET && sections.stories.length > 2) {
      sections.stories.pop();
      summary = buildSummary();
    }

    while (estimateTokens(summary) > PROJECT_CONTEXT_TOKEN_BUDGET && sections.epics.length > 1) {
      sections.epics.pop();
      summary = buildSummary();
    }

    if (estimateTokens(summary) > PROJECT_CONTEXT_TOKEN_BUDGET) {
      const overviewOnly = overviewLines.join('\n');
      const maxChars = Math.max(0, (PROJECT_CONTEXT_TOKEN_BUDGET - REQUIRED_OVERVIEW_HEADROOM_TOKENS) * 4);
      summary = `${overviewOnly}\nproject_context_notes: ${truncateText(summary, maxChars)}`;
    }

    if (estimateTokens(summary) > PROJECT_CONTEXT_TOKEN_BUDGET) {
      summary = truncateText(summary, PROJECT_CONTEXT_TOKEN_BUDGET * 4);
    }

    return {
      project: sanitizedProject,
      teamMembers: data.teamMembers,
      summary,
      meta: {
        source,
        usedFallback,
        timedOut,
        tokenCount: estimateTokens(summary),
      },
    };
  }
}

export const projectContextRedaction = {
  redactSecrets,
  estimateTokens,
};
