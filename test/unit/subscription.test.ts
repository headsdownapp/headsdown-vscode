import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AvailabilitySubscription } from "../../src/subscription.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocol: string;
  readyState = 1;
  sent: string[] = [];

  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data?: string }) => void) | null = null;

  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  triggerOpen(): void {
    this.onopen?.({});
  }

  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  triggerClose(code = 1006, reason = "abnormal"): void {
    this.onclose?.({ code, reason });
  }
}

describe("AvailabilitySubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as unknown as { WebSocket?: typeof FakeWebSocket }).WebSocket;
  });

  it("connects with graphql-transport-ws and sends connection_init token", () => {
    const callbacks = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onContractChanged: vi.fn(),
      onError: vi.fn(),
    };

    const sub = new AvailabilitySubscription(
      { log: vi.fn() } as unknown as any,
      () => "https://headsdown.app",
      () => "hd_test_token",
      callbacks,
    );

    sub.start();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("wss://headsdown.app/api/graphql-ws");
    expect(ws.protocol).toBe("graphql-transport-ws");

    ws.triggerOpen();

    expect(ws.sent).toHaveLength(1);
    const initMessage = JSON.parse(ws.sent[0]) as { type: string; payload: { token: string } };
    expect(initMessage.type).toBe("connection_init");
    expect(initMessage.payload.token).toBe("hd_test_token");
  });

  it("subscribes on connection_ack and emits contractChanged on next", () => {
    const callbacks = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onContractChanged: vi.fn(),
      onError: vi.fn(),
    };

    const sub = new AvailabilitySubscription(
      { log: vi.fn() } as unknown as any,
      () => "https://headsdown.app",
      () => "hd_test_token",
      callbacks,
    );

    sub.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();

    ws.triggerMessage({ type: "connection_ack" });

    expect(callbacks.onConnected).toHaveBeenCalledOnce();
    expect(ws.sent).toHaveLength(2);
    const subscribeMessage = JSON.parse(ws.sent[1]) as {
      id: string;
      type: string;
      payload: { query: string };
    };
    expect(subscribeMessage.type).toBe("subscribe");
    expect(subscribeMessage.id).toBe("contract-changed");

    ws.triggerMessage({ id: "contract-changed", type: "next", payload: {} });
    expect(callbacks.onContractChanged).toHaveBeenCalledOnce();
  });

  it("falls back via disconnect callback and reconnects with backoff", () => {
    const callbacks = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onContractChanged: vi.fn(),
      onError: vi.fn(),
    };

    const sub = new AvailabilitySubscription(
      { log: vi.fn() } as unknown as any,
      () => "https://headsdown.app",
      () => "hd_test_token",
      callbacks,
    );

    sub.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    ws.triggerMessage({ type: "connection_ack" });

    ws.triggerClose(1006, "abnormal");
    expect(callbacks.onDisconnected).toHaveBeenCalledOnce();

    // First reconnect attempt after 1s
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect after stop", () => {
    const callbacks = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onContractChanged: vi.fn(),
      onError: vi.fn(),
    };

    const sub = new AvailabilitySubscription(
      { log: vi.fn() } as unknown as any,
      () => "https://headsdown.app",
      () => "hd_test_token",
      callbacks,
    );

    sub.start();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    ws.triggerMessage({ type: "connection_ack" });

    ws.triggerClose(1006, "abnormal");
    expect(callbacks.onDisconnected).toHaveBeenCalledOnce();

    sub.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
