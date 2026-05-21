import type { HighlighterGeneric } from 'shiki';

export const SUPPORTED_LANGUAGES = [
  'javascript', 'typescript', 'python', 'go', 'rust', 'sql', 'json', 'yaml',
  'bash', 'html', 'css', 'java', 'c', 'cpp', 'ruby', 'php', 'swift', 'kotlin',
  'dart', 'markdown', 'docker', 'terraform', 'graphql', 'shell', 'powershell',
  'lua', 'r', 'scala', 'elixir', 'haskell',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<string, string> = {
  javascript: 'JS', typescript: 'TS', python: 'Python', go: 'Go', rust: 'Rust',
  sql: 'SQL', json: 'JSON', yaml: 'YAML', bash: 'Bash', html: 'HTML', css: 'CSS',
  java: 'Java', c: 'C', cpp: 'C++', ruby: 'Ruby', php: 'PHP', swift: 'Swift',
  kotlin: 'Kotlin', dart: 'Dart', markdown: 'Markdown', docker: 'Docker',
  terraform: 'Terraform', graphql: 'GraphQL', shell: 'Shell', powershell: 'PS',
  lua: 'Lua', r: 'R', scala: 'Scala', elixir: 'Elixir', haskell: 'Haskell',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHighlighter = HighlighterGeneric<any, any>;

let highlighterPromise: Promise<AnyHighlighter> | null = null;

export async function getShikiHighlighter(): Promise<AnyHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import('shiki');
      return createHighlighter({
        themes: ['dark-plus'],
        langs: [...SUPPORTED_LANGUAGES],
      });
    })();
  }
  return highlighterPromise;
}

export function resolveLanguage(lang: string | null | undefined): string {
  if (!lang) return 'text';
  const lower = lang.toLowerCase();
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lower)) return lower;
  const aliases: Record<string, string> = {
    js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', yml: 'yaml',
    'c++': 'cpp', 'c#': 'csharp', jsx: 'javascript', tsx: 'typescript',
  };
  return aliases[lower] ?? 'text';
}
