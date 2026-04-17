import { z } from 'zod';
import { mcpTokenRefSchema } from '@/lib/mcp-secrets';

export const GITHUB_MCP_TOOL_NAMES = [
  'github.list_issues',
  'github.create_issue',
  'github.comment_issue',
  'github.list_pull_requests',
  'github.get_pull_request',
  'github.merge_pull_request',
] as const;

export type GitHubMcpToolName = typeof GITHUB_MCP_TOOL_NAMES[number];

export const githubMcpConfigSchema = z.object({
  gateway_url: z.string().url(),
  auth: z.object({
    token_ref: mcpTokenRefSchema,
    header_name: z.string().min(1).optional(),
    scheme: z.enum(['bearer', 'plain']).optional(),
  }),
}).strict();

export const githubMcpToolArgumentSchemas: Record<GitHubMcpToolName, z.ZodType<Record<string, unknown>>> = {
  'github.list_issues': z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    state: z.enum(['open', 'closed', 'all']).optional(),
    labels: z.array(z.string().min(1)).optional(),
    assignee: z.string().min(1).optional(),
    page: z.coerce.number().int().min(1).optional(),
    per_page: z.coerce.number().int().min(1).max(100).optional(),
  }).strict(),
  'github.create_issue': z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    title: z.string().min(1),
    body: z.string().optional(),
    labels: z.array(z.string().min(1)).optional(),
    assignees: z.array(z.string().min(1)).optional(),
  }).strict(),
  'github.comment_issue': z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issue_number: z.coerce.number().int().positive(),
    body: z.string().min(1),
  }).strict(),
  'github.list_pull_requests': z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    state: z.enum(['open', 'closed', 'all']).optional(),
    head: z.string().min(1).optional(),
    base: z.string().min(1).optional(),
    page: z.coerce.number().int().min(1).optional(),
    per_page: z.coerce.number().int().min(1).max(100).optional(),
  }).strict(),
  'github.get_pull_request': z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pull_number: z.coerce.number().int().positive(),
  }).strict(),
  'github.merge_pull_request': z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pull_number: z.coerce.number().int().positive(),
    merge_method: z.enum(['merge', 'squash', 'rebase']).optional(),
    commit_title: z.string().min(1).optional(),
    commit_message: z.string().min(1).optional(),
  }).strict(),
};

export function isGitHubMcpToolName(toolName: string): toolName is GitHubMcpToolName {
  return (GITHUB_MCP_TOOL_NAMES as readonly string[]).includes(toolName);
}
