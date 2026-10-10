import { createAdaptorServer, serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { createInMemoryDeps } from '../src/deps';
import type { InMemoryDepsOptions } from '../src/deps';

export const LISTING = 'listing-1';
export const TTL_MS = 10 * 60 * 1000;
export const MINUTE = 60 * 1000;

export type Api = ReturnType<typeof request>;

export function setup(options: InMemoryDepsOptions = {}) {
  const clock = new ManualClock();
  const deps = createInMemoryDeps({
    clock,
    timers: clock,
    stock: { [LISTING]: 1 },
    prices: { [LISTING]: 10000 },
    holdTtlMs: TTL_MS,
    ...options,
  });
  const app = createApp(deps);
  const api = request(createAdaptorServer({ fetch: app.fetch }));

  const createSession = async () => {
    const res = await api.post('/api/sessions').send({ listingId: LISTING });
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  };
  return { clock, deps, app, api, createSession };
}

/** POST /complete with the required `Idempotency-Key` header and client `version`. */
export function complete(api: Api, id: string, key: string, version: number) {
  return api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', key).send({ version });
}

/** Poll until `check` returns something truthy (for work that happens off-request, like timers). */
export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Listen on an ephemeral port so tests can hold a real streaming connection open. */
export async function listen(app: { fetch: (req: Request) => Response | Promise<Response> }) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

export interface SseFrame {
  event?: string;
  id?: string;
  data?: string;
  /** Comment lines (":" prefix), e.g. heartbeats. */
  comment?: string;
}

const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

/** Minimal SSE client over fetch, so tests can read frames one at a time. */
export async function openEvents(url: string) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (raw: string): SseFrame => {
    const frame: SseFrame = {};
    for (const line of raw.split(NL)) {
      if (line.startsWith(':')) frame.comment = line.slice(1).trim();
      else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
      else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
      else if (line.startsWith('data:')) frame.data = (frame.data ? frame.data + NL : '') + line.slice(5).trim();
    }
    return frame;
  };

  /** Next frame, or `null` when the server closed the stream. */
  async function next(timeoutMs = 2000): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf(NL + NL);
      if (end >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return parse(raw);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for an SSE frame');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out waiting for an SSE frame')), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true }).split(CRLF).join(NL);
    }
  }

  /** Next frame that carries a session event (skips heartbeats); `null` if the stream closed. */
  async function nextSession(timeoutMs = 2000) {
    for (;;) {
      const frame = await next(timeoutMs);
      if (frame === null) return null;
      if (frame.event === 'session') {
        return JSON.parse(frame.data!) as { status: string; version: number; [key: string]: unknown };
      }
    }
  }

  return { status: res.status, headers: res.headers, next, nextSession, close: () => controller.abort() };
}
