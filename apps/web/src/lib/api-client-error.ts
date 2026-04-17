import type { ApiErrorPayload } from '@/lib/api-response';

export interface ApiClientErrorInfo {
  code?: string;
  message: string;
  meterType?: string;
  details?: Record<string, unknown>;
}

export class ApiClientError extends Error {
  readonly code?: string;
  readonly meterType?: string;
  readonly details?: Record<string, unknown>;

  constructor(info: ApiClientErrorInfo) {
    super(info.message);
    this.name = 'ApiClientError';
    this.code = info.code;
    this.meterType = info.meterType;
    this.details = info.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNestedError(body: unknown): ApiErrorPayload | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (!isRecord(error)) return null;
  if (typeof error.code !== 'string' && typeof error.message !== 'string') return null;
  return error as ApiErrorPayload;
}

export async function readApiClientError(response: Response, fallbackMessage: string): Promise<ApiClientErrorInfo> {
  const body = await response.json().catch(() => null);
  const nestedError = readNestedError(body);
  const details = isRecord(nestedError?.details) ? nestedError.details : undefined;
  const meterType = typeof (body as { meterType?: unknown } | null)?.meterType === 'string'
    ? (body as { meterType: string }).meterType
    : typeof details?.meterType === 'string'
      ? details.meterType
      : undefined;

  return {
    code: typeof (body as { code?: unknown } | null)?.code === 'string'
      ? (body as { code: string }).code
      : nestedError?.code,
    message: typeof (body as { message?: unknown } | null)?.message === 'string'
      ? (body as { message: string }).message
      : nestedError?.message ?? fallbackMessage,
    meterType,
    details,
  };
}

export async function createApiClientError(response: Response, fallbackMessage: string) {
  return new ApiClientError(await readApiClientError(response, fallbackMessage));
}
