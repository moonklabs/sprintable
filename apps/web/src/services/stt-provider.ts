import { createApiClientError } from '@/lib/api-client-error';

/**
 * STT Provider Adapter Pattern (AC4)
 *
 * 지원 제공자:
 * - browser: Web Speech API (실시간 마이크 전용)
 * - whisper: OpenAI Whisper API (BYOM — 사용자 제공 API key, 클라이언트 직접 호출)
 * - server: 서버 사이드 Whisper (/api/meetings/:id/transcribe 경유)
 *
 * 파일 업로드 STT는 server provider 사용 (Web Speech API는 마이크 전용)
 */

export interface SttResult {
  text: string;
  provider: string;
  durationMs?: number;
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Blob | null, lang: string, onProgress?: (pct: number) => void): Promise<SttResult>;
}

// ─── Browser Web Speech Provider (실시간 마이크 전용) ───

class BrowserSttProvider implements SttProvider {
  readonly name = 'browser';

  async transcribe(audio: Blob | null, _lang: string, _onProgress?: (pct: number) => void): Promise<SttResult> {
    if (audio) {
      // Web Speech API는 마이크 입력만 지원 — 파일 업로드는 서버 STT 필요
      throw new Error('FILE_UPLOAD_REQUIRES_SERVER_STT');
    }
    // 실시간 모드는 AudioRecorder 컴포넌트에서 직접 처리
    throw new Error('Browser STT is handled inline by AudioRecorder');
  }
}

// ─── Whisper API Provider (BYOM, 클라이언트 직접) ───

class WhisperSttProvider implements SttProvider {
  readonly name = 'whisper';

  constructor(private readonly apiKey: string) {}

  async transcribe(audio: Blob | null, lang: string, onProgress?: (pct: number) => void): Promise<SttResult> {
    if (!audio) throw new Error('Whisper requires audio file');

    onProgress?.(10);
    const startMs = Date.now();

    const formData = new FormData();
    formData.append('file', audio, 'recording.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', lang.split('-')[0]);

    onProgress?.(30);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    onProgress?.(80);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: { message?: string } })?.error?.message ?? `Whisper API error: ${res.status}`);
    }

    const data = (await res.json()) as { text: string };
    onProgress?.(100);

    return { text: data.text, provider: 'whisper', durationMs: Date.now() - startMs };
  }
}

// ─── Server STT Provider (서버 경유 Whisper) ───

class ServerSttProvider implements SttProvider {
  readonly name = 'server';

  constructor(private readonly meetingId: string, private readonly byomKey?: string) {}

  async transcribe(audio: Blob | null, _lang: string, onProgress?: (pct: number) => void): Promise<SttResult> {
    if (!audio) throw new Error('Server STT requires audio file');

    onProgress?.(10);
    const startMs = Date.now();

    const formData = new FormData();
    formData.append('audio', audio, 'recording.webm');
    if (this.byomKey) formData.append('apiKey', this.byomKey);

    onProgress?.(30);

    const res = await fetch(`/api/meetings/${this.meetingId}/transcribe`, {
      method: 'POST',
      body: formData,
    });

    onProgress?.(80);

    if (!res.ok) {
      throw await createApiClientError(res, `Server STT error: ${res.status}`);
    }

    const data = (await res.json()) as { data: { text: string } };
    onProgress?.(100);

    return { text: data.data.text, provider: 'server', durationMs: Date.now() - startMs };
  }
}

// ─── Factory ───

export type SttProviderType = 'browser' | 'whisper' | 'server';

export function createSttProvider(
  type: SttProviderType,
  options?: { apiKey?: string; meetingId?: string },
): SttProvider {
  switch (type) {
    case 'whisper':
      if (!options?.apiKey) throw new Error('Whisper provider requires API key');
      return new WhisperSttProvider(options.apiKey);
    case 'server':
      if (!options?.meetingId) throw new Error('Server provider requires meetingId');
      return new ServerSttProvider(options.meetingId, options.apiKey);
    case 'browser':
    default:
      return new BrowserSttProvider();
  }
}
