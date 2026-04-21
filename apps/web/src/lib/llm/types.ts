export type LLMProvider = 'openai' | 'anthropic' | 'google' | 'groq' | 'openai-compatible';

export type AnthropicModel = 'claude-sonnet-4' | 'claude-opus-4';
export type OpenAIModel = 'gpt-4o' | 'gpt-4o-mini';
export type GoogleModel = 'gemini-2.5-flash' | 'gemini-2.5-pro';
export type GroqModel = 'llama-3.1-8b-instant' | 'llama-3.3-70b-versatile';
export type LLMModel = AnthropicModel | OpenAIModel | GoogleModel | GroqModel | string;

export const LLM_PROVIDERS: LLMProvider[] = ['openai', 'anthropic', 'google', 'groq', 'openai-compatible'];

export const OPENAI_MODELS: OpenAIModel[] = ['gpt-4o-mini', 'gpt-4o'];
export const ANTHROPIC_MODELS: AnthropicModel[] = ['claude-sonnet-4', 'claude-opus-4'];
export const GOOGLE_MODELS: GoogleModel[] = ['gemini-2.5-flash', 'gemini-2.5-pro'];
export const GROQ_MODELS: GroqModel[] = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];

export function providerSwitchRequiresNewApiKey(
  currentProvider: LLMProvider | null | undefined,
  nextProvider: LLMProvider,
): boolean {
  return Boolean(currentProvider && currentProvider !== nextProvider);
}

export interface ExternalMcpAuthConfig {
  token_ref: string;
  header_name?: string;
  scheme?: 'bearer' | 'plain';
}

export interface ExternalMcpServerConfig {
  name: string;
  url: string;
  allowed_tools: string[];
  auth?: ExternalMcpAuthConfig;
}

export interface GitHubMcpConfig {
  gateway_url: string;
  auth: ExternalMcpAuthConfig;
}

export interface PersistedLLMConfig {
  model?: LLMModel;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  perRunCapCents?: number;
  mcp_servers?: ExternalMcpServerConfig[];
  github_mcp?: GitHubMcpConfig;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string;
  usage: LLMTokenUsage;
}

export interface LLMGenerateOptions {
  responseFormat?: 'json_object';
  maxTokens?: number;
  temperature?: number;
}

export interface LLMConfig extends PersistedLLMConfig {
  provider: LLMProvider;
  billingMode: 'managed' | 'byom';
  model: LLMModel;
  apiKey: string;
}

export interface LLMClient {
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
}
