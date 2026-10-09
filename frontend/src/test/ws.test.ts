import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, buildStreamUrl, ExecutionStream, type WsLike } from "@/services/ws";
import type { RunEvent } from "@/types";

class FakeSocket implements WsLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  close() {
    this.closed = true;
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const ev = (seq: number, type = "node.started"): RunEvent => ({
  seq,
  run_id: "r1",
  type,
  node_id: "a",
  node_run_id: null,
  data: {},
  created_at: new Date().toISOString(),
});

describe("buildStreamUrl", () => {
  it("uses ws/wss from the page protocol and encodes params", () => {
    expect(buildStreamUrl({ protocol: "http:", host: "localhost:5173" }, "r1", "tok", 0)).toBe(
      "ws://localhost:5173/api/executions/r1/stream?token=tok&after=0",
    );
    expect(buildStreamUrl({ protocol: "https:", host: "app.example.com" }, "r 2", "a+b", 17)).toBe(
      "wss://app.example.com/api/executions/r%202/stream?token=a%2Bb&after=17",
    );
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and caps", () => {
    const r = () => 1;
    expect(backoffDelay(0, 500, 15000, r)).toBe(500);
    expect(backoffDelay(1, 500, 15000, r)).toBe(1000);
    expect(backoffDelay(3, 500, 15000, r)).toBe(4000);
    expect(backoffDelay(10, 500, 15000, r)).toBe(15000);
    expect(backoffDelay(2, 500, 15000, () => 0)).toBe(1000);
  });
});

describe("ExecutionStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (after = 0) => {
    const events: RunEvent[] = [];
    const statuses: string[] = [];
    const s = new ExecutionStream({
      runId: "r1",
      after,
      getToken: () => "tok",
      onEvent: (e) => events.push(e),
      onStatus: (st) => statuses.push(st),
      socketFactory: (u) => new FakeSocket(u),
      location: { protocol: "http:", host: "h" },
      baseDelayMs: 100,
      maxDelayMs: 1000,
      idleTimeoutMs: 0,
      random: () => 1,
    });
    return { s, events, statuses };
  };

  it("tracks the highest seq, ignores pings and duplicates", () => {
    const { s, events } = make(2);
    s.start();
    const sock = FakeSocket.instances[0]!;
    expect(sock.url).toContain("after=2");
    sock.open();
    sock.send({ type: "event", event: ev(1) }); // older than after -> dropped
    sock.send({ type: "event", event: ev(3) });
    sock.send({ type: "ping" });
    sock.send({ type: "event", event: ev(4) });
    sock.send({ type: "event", event: ev(4) }); // duplicate
    sock.onmessage?.({ data: "not json" });
    expect(events.map((e) => e.seq)).toEqual([3, 4]);
    expect(s.lastSeq).toBe(4);
  });

  it("reconnects with backoff using after=<lastSeq>", () => {
    const { s, events, statuses } = make(0);
    s.start();
    let sock = FakeSocket.instances[0]!;
    sock.open();
    sock.send({ type: "event", event: ev(1) });
    sock.send({ type: "event", event: ev(2) });
    sock.drop();
    expect(statuses).toContain("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    sock = FakeSocket.instances[1]!;
    expect(sock.url).toContain("after=2");
    // second failure before open -> longer delay
    sock.drop();
    vi.advanceTimersByTime(150);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(60);
    expect(FakeSocket.instances).toHaveLength(3);
    sock = FakeSocket.instances[2]!;
    sock.open();
    expect(statuses[statuses.length - 1]).toBe("open");
    // replay overlaps: server resends 2, then 3
    sock.send({ type: "event", event: ev(2) });
    sock.send({ type: "event", event: ev(3) });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // after successful open the backoff resets
    sock.drop();
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(FakeSocket.instances[3]!.url).toContain("after=3");
  });

  it("stops cleanly and does not reconnect", () => {
    const { s, statuses } = make();
    s.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    s.stop();
    expect(sock.closed).toBe(true);
    sock.drop();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses[statuses.length - 1]).toBe("closed");
  });

  it("gives up on auth/not-found close codes", () => {
    const { s } = make();
    s.start();
    FakeSocket.instances[0]!.drop(4401);
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(s.status).toBe("closed");
  });
});
