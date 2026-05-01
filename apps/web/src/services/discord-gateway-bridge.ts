// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { BridgeInboundService } from './bridge-inbound';
import {
  type DiscordBridgeConfig,
  type DiscordGatewayPayload,
  type DiscordMessageEvent,
  getDiscordSourceChannelId,
  normalizeDiscordEvent,
  postDiscordRateLimitNotice,
  resolveDiscordBridgeConfig,
  shouldIgnoreDiscordMessage,
} from './discord-inbound';

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type SocketFactory = (url: string) => WebSocketLike;
type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface DiscordGatewayBridgeOptions {
  supabase: SupabaseClient;
  orgId: string;
  token: string;
  socketFactory?: SocketFactory;
  logger?: Logger;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  onAuthFailed?: (orgId: string, reason: string) => Promise<void> | void;
  inboundService?: BridgeInboundService;
  postRateLimitNoticeFn?: typeof postDiscordRateLimitNotice;
}

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000;
const GATEWAY_INTENTS = 1 + 512 + 32768;

export class DiscordGatewayBridge {
  private readonly socketFactory: SocketFactory;
  private readonly logger: Logger;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly inboundService: BridgeInboundService;
  private readonly postRateLimitNoticeFn: typeof postDiscordRateLimitNotice;

  private socket: WebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private botUserId: string | null = null;
  private shouldResume = false;

  constructor(private readonly options: DiscordGatewayBridgeOptions) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.logger = options.logger ?? console;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.inboundService = options.inboundService ?? new BridgeInboundService(options.supabase);
    this.postRateLimitNoticeFn = options.postRateLimitNoticeFn ?? postDiscordRateLimitNotice;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close(1000, 'stopped');
      this.socket = null;
    }
  }

  private connect() {
    if (this.stopped) return;

    const socket = this.socketFactory(DEFAULT_GATEWAY_URL);
    this.socket = socket;
    socket.onopen = () => {
      this.logger.info(`[DiscordGatewayBridge] Gateway connected for org ${this.options.orgId}`);
    };
    socket.onmessage = (event) => {
      void this.handleMessage(event.data);
    };
    socket.onerror = (event) => {
      this.logger.warn('[DiscordGatewayBridge] Gateway error event', event as never);
    };
    socket.onclose = (event) => {
      this.logger.warn(`[DiscordGatewayBridge] Gateway closed for org ${this.options.orgId}`, event as never);
      if (event.code === 4000 && event.reason === 'reconnect') {
        return;
      }
      if (event.code === 4004) {
        this.shouldResume = false;
        void this.options.onAuthFailed?.(this.options.orgId, 'auth_failed');
        return;
      }
      if (!this.stopped) {
        this.shouldResume = Boolean(this.sessionId && this.sequence !== null);
      }
      this.scheduleReconnect();
    };
  }

  private async handleMessage(raw: string) {
    const payload = JSON.parse(raw) as DiscordGatewayPayload;
    if (typeof payload.s === 'number') {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 10: {
        const heartbeatInterval = Number((payload.d as { heartbeat_interval?: number }).heartbeat_interval ?? 0);
        this.startHeartbeat(heartbeatInterval);
        if (this.shouldResume && this.sessionId && this.sequence !== null) {
          this.resume();
        } else {
          this.identify();
        }
        break;
      }
      case 11:
        this.reconnectAttempt = 0;
        break;
      case 7:
        this.shouldResume = Boolean(this.sessionId && this.sequence !== null);
        this.scheduleReconnect();
        break;
      case 9:
        if ((payload.d as boolean | undefined) === false) {
          this.sessionId = null;
          this.sequence = null;
          this.shouldResume = false;
        } else {
          this.shouldResume = Boolean(this.sessionId && this.sequence !== null);
        }
        this.scheduleReconnect();
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 0:
        await this.handleDispatchEvent(payload);
        break;
      default:
        break;
    }
  }

  private async handleDispatchEvent(payload: DiscordGatewayPayload) {
    if (payload.t === 'READY') {
      const ready = payload.d as { session_id?: string; user?: { id?: string } };
      this.sessionId = ready.session_id ?? null;
      this.botUserId = ready.user?.id ?? null;
      this.shouldResume = false;
      return;
    }

    if (payload.t === 'RESUMED') {
      this.shouldResume = false;
      return;
    }

    if (payload.t !== 'MESSAGE_CREATE') return;
    const event = payload.d as DiscordMessageEvent;
    const mapping = await this.inboundService.findChannelMapping('discord', getDiscordSourceChannelId(event));
    if (!mapping) return;

    const config = resolveDiscordBridgeConfig(mapping.config ?? null);
    const effectiveConfig: DiscordBridgeConfig = {
      ...config,
      botUserId: config.botUserId ?? this.botUserId,
    };

    if (shouldIgnoreDiscordMessage(event, effectiveConfig)) return;

    const result = await this.inboundService.processInboundMessage({
      platform: 'discord',
      mapping,
      event: normalizeDiscordEvent(event, effectiveConfig),
      unknownUserLabel: 'Discord 연동 미설정 사용자',
    });

    if (result.action === 'rate_limited') {
      await this.postRateLimitNoticeFn(this.options.token, { channelId: event.channel_id });
    }
  }

  private identify() {
    this.send({
      op: 2,
      d: {
        token: this.options.token,
        intents: GATEWAY_INTENTS,
        properties: {
          os: 'sprintable',
          browser: 'sprintable',
          device: 'sprintable',
        },
        presence: {
          status: 'online',
          since: null,
          afk: false,
          activities: [],
        },
      },
    });
  }

  private resume() {
    this.send({
      op: 6,
      d: {
        token: this.options.token,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (!intervalMs || Number.isNaN(intervalMs)) return;
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat() {
    this.send({ op: 1, d: this.sequence });
  }

  private send(payload: Record<string, unknown>) {
    this.socket?.send(JSON.stringify(payload));
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) return;

    const delay = Math.min(this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt, this.reconnectMaxDelayMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.socket) {
        this.socket.close(4000, 'reconnect');
        this.socket = null;
      }
      this.connect();
    }, delay);
  }
}
