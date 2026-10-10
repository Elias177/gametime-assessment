import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { ClientContext, RequestAction } from '../src/checkout-service';
import { LISTING, asClient, listen, openEvents, setup, startSession } from './helpers';

/** The same deps behind a second app that records every request's client. */
function setupRecording() {
  const base = setup();
  const seen: Array<{ action: RequestAction; sessionId?: string; client: ClientContext }> = [];
  const app = createApp(base.deps, { onRequest: (req) => seen.push(req) });
  const api = request(createAdaptorServer({ fetch: app.fetch }));
  return { ...base, app, api, seen };
}

describe('session origin', () => {
  it('records when, from which client and from which surface a session was created', async () => {
    const { api, clock } = setup();
    clock.advance(1234);

    const created = await startSession(api, LISTING, 'laptop-1', 'web');

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      createdAt: clock.now().toISOString(),
      originClientId: 'laptop-1',
      originSurface: 'web',
    });
  });

  it('keeps the origin when another client reads, acknowledges or completes the session', async () => {
    const { api, clock } = setup();
    const created = await startSession(api, LISTING, 'laptop-1', 'web');
    const id = created.body.id as string;
    const origin = {
      createdAt: created.body.createdAt,
      originClientId: 'laptop-1',
      originSurface: 'web',
    };
    clock.advance(1000);

    const read = await asClient(api.get(`/api/sessions/${id}`), 'phone-1', 'mobile');
    expect(read.body).toMatchObject(origin);

    const done = await asClient(
      api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', 'k1'),
      'phone-1',
      'mobile',
    ).send({ version: 1 });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject(origin);
  });

  it('refuses to create a session without a client id or with an unknown surface', async () => {
    const { api } = setup();

    const noClient = await api.post('/api/sessions').set('X-Surface', 'web').send({ listingId: LISTING });
    expect(noClient.status).toBe(400);
    expect(noClient.body.error.code).toBe('INVALID_REQUEST');

    const noSurface = await api.post('/api/sessions').set('X-Client-Id', 'c1').send({ listingId: LISTING });
    expect(noSurface.status).toBe(400);

    const badSurface = await startSession(api, LISTING, 'c1', 'toaster');
    expect(badSurface.status).toBe(400);
    expect(badSurface.body.error.message).toContain('web or mobile');
  });

  it('does not take a hold when the create is refused', async () => {
    const { api, createSession } = setup(); // stock 1
    await api.post('/api/sessions').send({ listingId: LISTING });

    expect((await createSession()).version).toBe(1);
  });
});

describe('client context reaches the service', () => {
  it('passes X-Client-Id and X-Surface from every API call', async () => {
    const { api, seen } = setupRecording();
    const created = await startSession(api, LISTING, 'laptop-1', 'web');
    const id = created.body.id as string;

    await asClient(api.get(`/api/sessions/${id}`), 'phone-1', 'mobile');
    await asClient(api.post(`/api/sessions/${id}/acknowledge`), 'phone-1', 'mobile').send({ version: 1 });
    await asClient(api.post(`/api/sessions/${id}/complete`).set('Idempotency-Key', 'k1'), 'laptop-1', 'web').send({
      version: 1,
    });

    expect(seen.map((s) => [s.action, s.client])).toEqual([
      ['create', { clientId: 'laptop-1', surface: 'web' }],
      ['get', { clientId: 'phone-1', surface: 'mobile' }],
      ['acknowledge', { clientId: 'phone-1', surface: 'mobile' }],
      ['complete', { clientId: 'laptop-1', surface: 'web' }],
    ]);
    expect(seen.every((s) => s.sessionId === id)).toBe(true);
  });

  it('ignores a missing or unknown surface on reads instead of failing them', async () => {
    const { api, seen } = setupRecording();
    const created = await startSession(api);
    const id = created.body.id as string;

    const res = await api.get(`/api/sessions/${id}`).set('X-Surface', 'toaster');

    expect(res.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ action: 'get', client: {} });
  });

  it('flags a pre-render prefetch (X-Prefetch: 1, no client headers) with prefetch: true', async () => {
    const { api, seen } = setupRecording();
    const created = await startSession(api);
    const id = created.body.id as string;

    const res = await api.get(`/api/sessions/${id}`).set('X-Prefetch', '1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'active' });
    expect(seen.at(-1)).toEqual({ action: 'get', sessionId: id, client: { prefetch: true } });
  });

  it('does not flag ordinary reads, and ignores any value other than "1"', async () => {
    const { api, seen } = setupRecording();
    const created = await startSession(api);
    const id = created.body.id as string;

    await asClient(api.get(`/api/sessions/${id}`), 'phone-1', 'mobile');
    await api.get(`/api/sessions/${id}`).set('X-Prefetch', 'true');
    await api.get(`/api/sessions/${id}`).set('X-Prefetch', '0');

    expect(seen.filter((s) => s.action === 'get').map((s) => s.client)).toEqual([
      { clientId: 'phone-1', surface: 'mobile' },
      {},
      {},
    ]);
  });

  it('accepts X-Prefetch only on the session read, not on writes or the stream', async () => {
    const { api, seen, createSession } = setupRecording();
    const { id, version } = await createSession();

    await api.post(`/api/sessions/${id}/acknowledge`).set('X-Prefetch', '1').send({ version });
    await api
      .post(`/api/sessions/${id}/complete`)
      .set('X-Prefetch', '1')
      .set('Idempotency-Key', 'k1')
      .send({ version });

    expect(seen.map((s) => [s.action, s.client])).toEqual([
      ['acknowledge', {}],
      ['complete', {}],
    ]);
  });

  it('a prefetch read re-evaluates the session like any other read', async () => {
    const { api, clock, createSession } = setupRecording();
    const { id } = await createSession();
    clock.advance(11 * 60 * 1000);

    const res = await api.get(`/api/sessions/${id}`).set('X-Prefetch', '1');

    expect(res.body.status).toBe('expired'); // the pre-render sees the truth and so will not inject
  });

  it('reads the client from query params on the SSE URL, since EventSource cannot set headers', async () => {
    const { app, seen, createSession } = setupRecording();
    const { id } = await createSession();
    const server = await listen(app);
    const stream = await openEvents(`${server.url}/api/sessions/${id}/events?clientId=phone-1&surface=mobile`);
    try {
      const first = await stream.nextSession();

      expect(first).toMatchObject({ originClientId: 'client-a', originSurface: 'web' });
      expect(seen.find((s) => s.action === 'stream')).toMatchObject({
        sessionId: id,
        client: { clientId: 'phone-1', surface: 'mobile' },
      });
    } finally {
      stream.close();
      await server.close();
    }
  });
});
