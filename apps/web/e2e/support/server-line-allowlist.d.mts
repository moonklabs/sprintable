export const SEGMENT_ID: string;
export type AllowedRecord =
  | { kind: 'request'; method: string; route: string; status: number | null; ms: number | null; parts: Record<string, number> }
  | { kind: 'compile'; phase: 'compiled' | 'compiling'; route: string; ms: number | null }
  | { kind: 'ready'; ms: number | null }
  | { kind: 'error'; name: string }
  | { kind: 'error-code'; code: string };
export function normalizeRoute(input: unknown): string;
export function parseServerLine(raw: unknown): AllowedRecord | null;
export function pickAllowed(rec: unknown): AllowedRecord | null;
export function formatRecord(rec: unknown): string | null;
export function isCompileFamily(rec: unknown): boolean;
export const ERROR_NAMES: Set<string>;
export const ERROR_CODES: Set<string>;
export function safeErrorName(name: unknown): string;
export function safeErrorCode(code: unknown): string;
export const HTTP_METHODS: Set<string>;
export const RESOURCE_TYPES: Set<string>;
export const NET_ERRORS: Set<string>;
export const DOC_READY_STATES: Set<string>;
export function safeMethod(m: unknown): string;
export function safeResourceType(t: unknown): string;
export function safeNetError(text: unknown): string | null;
export function safeReadyState(s: unknown): string;
