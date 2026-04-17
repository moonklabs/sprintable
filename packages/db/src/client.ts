/**
 * Supabase 클라이언트 팩토리
 */
import type { Database } from './types';

export interface SupabaseClientOptions {
  url: string;
  anonKey: string;
}

/**
 * Supabase 클라이언트 생성 (실제 구현은 @supabase/supabase-js 연동 시 교체)
 */
export function createSupabaseClient(options: SupabaseClientOptions): {
  url: string;
  anonKey: string;
} {
  return { url: options.url, anonKey: options.anonKey };
}

/**
 * 기본 클라이언트 — 환경변수 기반
 */
export const supabaseClient = {
  url: process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
  anonKey: process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '',
};
