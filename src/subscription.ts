import type { OutputLogger } from "./output.js";

interface SubscriptionCallbacks {
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onContractChanged: () => void;
  onError: (message: string) => void;
}

interface GraphQLWSMessage {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
}

const CONTRACT_CHANGED_SUBSCRIPTION = `
  subscription ContractChanged {
    contractChanged {
      id
    }
  }
`;

export class AvailabilitySubscription {
  private ws: {
    close: () => void;
    send: (data: string) => void;
    readyState: number;
    onopen: ((event: unknown) => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessage: ((event: { data?: string }) => void) | null;
  } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connected = false;
  private reconnectAttempt = 0;

  constructor(
    private readonly logger: OutputLogger,
    private readonly getBaseUrl: () => string,
    private readonly getToken: () => string | null,
    private readonly callbacks: SubscriptionCallbacks,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.reconnectAttempt = 0;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const token = this.getToken();
    if (!token) {
      this.callbacks.onError("Missing API token for GraphQL subscriptions");
      return;
    }

    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (...args: unknown[]) => any })
      .WebSocket;
    if (!WebSocketCtor) {
      this.callbacks.onError("WebSocket API unavailable, falling back to polling");
      return;
    }

    const wsUrl = toGraphqlWsUrl(this.getBaseUrl());
    this.logger.log(`Subscriptions: connecting to ${wsUrl}`);

    const ws = new WebSocketCtor(wsUrl, "graphql-transport-ws");
    this.ws = ws;

    ws.onopen = () => {
      this.send({ type: "connection_init", payload: { token } });
    };

    ws.onclose = (event: { code?: number; reason?: string }) => {
      const reason = `${event.code ?? 0}${event.reason ? ` ${event.reason}` : ""}`.trim();
      this.connected = false;
      this.ws = null;
      this.callbacks.onDisconnected(reason || "socket closed");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.callbacks.onError("WebSocket error, falling back to polling");
    };

    ws.onmessage = (event: { data?: string }) => {
      if (!event.data) return;

      let message: GraphQLWSMessage;
      try {
        message = JSON.parse(event.data) as GraphQLWSMessage;
      } catch {
        this.callbacks.onError("Failed to parse GraphQL WS message");
        return;
      }

      this.handleMessage(message);
    };
  }

  private handleMessage(message: GraphQLWSMessage): void {
    switch (message.type) {
      case "connection_ack":
        this.connected = true;
        this.reconnectAttempt = 0;
        this.callbacks.onConnected();
        this.send({
          id: "contract-changed",
          type: "subscribe",
          payload: { query: CONTRACT_CHANGED_SUBSCRIPTION },
        });
        return;

      case "next":
        if (message.id === "contract-changed") {
          this.callbacks.onContractChanged();
        }
        return;

      case "ping":
        this.send({ type: "pong" });
        return;

      case "error":
        this.callbacks.onError("GraphQL subscription error");
        return;

      case "complete":
      case "pong":
      default:
        return;
    }
  }

  private send(message: GraphQLWSMessage): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      this.callbacks.onError("Failed to send GraphQL WS message");
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;

    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}

function toGraphqlWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/graphql-ws";
  url.search = "";
  return url.toString();
}
