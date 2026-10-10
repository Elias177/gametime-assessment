import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const server = createAdaptorServer({ fetch: createApp().fetch });
    const res = await request(server).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.time).toBe('string');
  });
});
