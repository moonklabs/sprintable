'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useAudioRecorder, type RecorderErrorCode } from '@/hooks/use-audio-recorder';
import { createSttProvider, type SttProviderType } from '@/services/stt-provider';

interface AudioRecorderProps {
  onTranscript?: (text: string) => void;
  onAudioBlob?: (blob: Blob) => void;
  onUpgradeRequired?: (meterType: string) => void;
  sttProvider?: SttProviderType;
  sttApiKey?: string;
  meetingId?: string;
  lang?: string;
}

// ─── Waveform Canvas ───

function WaveformCanvas({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!analyser || !canvasRef.current) return undefined;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const data = new Uint8Array(analyser.frequencyBinCount);

    function draw() {
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      const sliceWidth = canvas.width / data.length;
      let x = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyser]);

  return <canvas ref={canvasRef} width={240} height={48} className="w-full max-w-[240px] rounded bg-gray-900" />;
}

// ─── Progress Bar (AC7) ───

function SttProgressBar({ progress, label }: { progress: number; label: string }) {
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
        <span>{label}</span>
        <span>{progress}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-300"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ─── Drop Zone (AC6) ───

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['audio/webm', 'audio/wav', 'audio/mp4', 'audio/mpeg', 'audio/ogg']);

function DropZone({ onFile, t }: { onFile: (file: File) => void; t: (key: string) => string }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }, [onFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = '';
  }, [onFile]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`mt-3 flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
        dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
      }`}
    >
      <span className="text-2xl">📁</span>
      <span className="mt-1 text-xs text-gray-500">{t('dropAudioFile')}</span>
      <span className="text-[10px] text-gray-400">{t('supportedFormats')}</span>
      <input
        ref={inputRef}
        type="file"
        accept="audio/webm,audio/wav,audio/mp4,audio/mpeg,audio/ogg"
        className="hidden"
        onChange={handleFileInput}
      />
    </div>
  );
}

// ─── Error code → i18n map ───

const ERROR_I18N_MAP: Record<RecorderErrorCode, string> = {
  micDenied: 'micDenied',
  recordingFailed: 'recordingFailed',
};

// ─── Main Component ───

export function AudioRecorder({
  onTranscript,
  onAudioBlob,
  onUpgradeRequired,
  sttProvider = 'browser',
  sttApiKey,
  meetingId,
  lang = 'ko-KR',
}: AudioRecorderProps) {
  const t = useTranslations('meeting');
  const {
    isRecording, duration, audioBlob, audioUrl, errorCode, analyser,
    startRecording, stopRecording,
  } = useAudioRecorder();

  const [sttProgress, setSttProgress] = useState(0);
  const [sttLoading, setSttLoading] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // ─── 실시간 녹음 + Browser STT ───

  const recognitionRef = useRef<{ stop(): void } | null>(null);
  const transcriptRef = useRef('');

  const handleStart = async () => {
    transcriptRef.current = '';
    setSttError(null);
    setFileError(null);
    setSttProgress(0);

    // 마이크 녹음 시 Browser STT는 항상 시도 (provider와 무관 — Web Speech API는 마이크 전용)
    {
      type SpeechRecognitionType = {
        continuous: boolean; interimResults: boolean; lang: string;
        onresult: ((e: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
        onerror: ((e: { error: string }) => void) | null;
        start(): void; stop(): void;
      };
      type Ctor = new () => SpeechRecognitionType;
      const w = window as unknown as Record<string, Ctor | undefined>;
      const SpeechAPI = w['SpeechRecognition'] ?? w['webkitSpeechRecognition'];
      if (SpeechAPI) {
        setSttLoading(true);
        const recognition = new SpeechAPI();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = lang;
        recognition.onresult = (e) => {
          let text = '';
          for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + ' ';
          transcriptRef.current = text;
          setSttProgress(50);
        };
        recognition.onerror = () => { setSttError(t('sttFailed')); setSttLoading(false); };
        recognition.start();
        recognitionRef.current = recognition;
      }
    }

    await startRecording();
  };

  // Browser STT 결과가 있으면 저장, 없으면 fallback 필요 플래그
  const needServerFallbackRef = useRef(false);

  const handleStop = async () => {
    stopRecording();
    recognitionRef.current?.stop();
    recognitionRef.current = null;

    // 마이크 녹음 완료 → Browser STT 결과 전달
    if (transcriptRef.current) {
      setSttProgress(100);
      setSttLoading(false);
      onTranscript?.(transcriptRef.current.trim());
      needServerFallbackRef.current = false;
    } else {
      // Browser STT 실패/미지원 → blob 도착 후 서버 STT fallback
      needServerFallbackRef.current = true;
    }
  };

  // ─── 녹음 blob 완료 후 처리 ───

  const prevBlobRef = useRef<Blob | null>(null);

  useEffect(() => {
    if (!audioBlob || audioBlob === prevBlobRef.current) return;
    prevBlobRef.current = audioBlob;

    queueMicrotask(() => {
      onAudioBlob?.(audioBlob);

      // Browser STT 실패/미지원 시 서버 STT fallback (blob 도착 후 실행)
      if (needServerFallbackRef.current && meetingId) {
        needServerFallbackRef.current = false;
        setSttLoading(true);
        setSttProgress(0);
        const provider = createSttProvider('server', { meetingId, apiKey: sttApiKey });
        provider
          .transcribe(audioBlob, lang, (pct) => setSttProgress(pct))
          .then((result) => {
            onTranscript?.(result.text);
            setSttLoading(false);
          })
          .catch((fallbackErr) => {
            const errMsg = fallbackErr instanceof Error ? fallbackErr.message : t('sttFailed');
            if (errMsg.includes('UPGRADE_REQUIRED') || errMsg.includes('limit reached')) {
              onUpgradeRequired?.('stt_minutes');
            }
            setSttError(errMsg);
            setSttLoading(false);
          });
      }
    });
  }, [audioBlob, onAudioBlob, meetingId, sttApiKey, lang, onTranscript, onUpgradeRequired, t]);

  // ─── AC6: 파일 업로드 핸들러 ───

  const handleFileUpload = useCallback((file: File) => {
    setFileError(null);
    setSttError(null);

    if (file.size > MAX_FILE_SIZE) {
      setFileError(t('fileTooLarge'));
      return;
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      setFileError(t('unsupportedFormat'));
      return;
    }

    // blob으로 변환하여 onAudioBlob 전달
    const blob = new Blob([file], { type: file.type });
    onAudioBlob?.(blob);

    // STT 실행 — 파일 업로드는 항상 서버 STT 사용 (Web Speech API는 마이크 전용)
    if (!meetingId) {
      setSttError(t('sttFailed'));
      return;
    }


    setSttLoading(true);
    setSttProgress(0);

    const provider = sttApiKey
      ? createSttProvider('whisper', { apiKey: sttApiKey })
      : createSttProvider('server', { meetingId, apiKey: sttApiKey });

    provider
      .transcribe(blob, lang, (pct) => setSttProgress(pct))
      .then((result) => {
        onTranscript?.(result.text);
        setSttLoading(false);
      })
      .catch((err) => {
        const errMsg2 = err instanceof Error ? err.message : t('sttFailed');
        if (errMsg2.includes('UPGRADE_REQUIRED') || errMsg2.includes('limit reached')) {
          onUpgradeRequired?.('stt_minutes');
        }
        setSttError(errMsg2);
        setSttLoading(false);
      });
  }, [sttApiKey, meetingId, lang, onAudioBlob, onTranscript, onUpgradeRequired, t]);

  // ─── Duration format ───

  const formatDuration = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="rounded-lg border bg-white p-4">
      {/* 에러 표시 */}
      {errorCode && <p className="mb-2 text-xs text-red-500">{t(ERROR_I18N_MAP[errorCode])}</p>}
      {sttError && <p className="mb-2 text-xs text-yellow-600">{sttError}</p>}
      {fileError && <p className="mb-2 text-xs text-red-500">{fileError}</p>}

      {/* 녹음 상태 (AC2 + AC11 모바일 반응형) */}
      <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
        {isRecording && (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
            <span className="shrink-0 font-mono text-sm text-gray-700">{formatDuration(duration)}</span>
            <div className="w-full sm:w-auto">
              <WaveformCanvas analyser={analyser} />
            </div>
          </>
        )}
      </div>

      {/* 녹음 버튼 (AC1 + AC11 모바일) */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {!isRecording ? (
          <button
            onClick={handleStart}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            🎙 {t('startRecording')}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="flex items-center gap-2 rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            ⏹ {t('stopRecording')}
          </button>
        )}
      </div>

      {/* AC7: STT 프로그레스 바 */}
      {sttLoading && (
        <SttProgressBar progress={sttProgress} label={t('sttInProgress')} />
      )}

      {/* 오디오 재생 */}
      {audioUrl && (
        <div className="mt-3">
          <audio controls src={audioUrl} className="w-full" />
        </div>
      )}

      {/* AC6: 파일 업로드 (드래그앤드롭) */}
      {!isRecording && <DropZone onFile={handleFileUpload} t={t} />}
    </div>
  );
}
