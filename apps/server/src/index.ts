import { serve } from '@hono/node-server';
import { createApp } from './app';
import { OffsetClock } from './clock';
import { createInMemoryDeps } from './deps';
import type { PaymentBehavior } from './services/payment';

const port = Number(process.env.PORT ?? 3001);
// Demo controls (/api/dev) exist only when explicitly switched on.
const devTools = process.env.DEV_TOOLS === '1';
const clock = devTools ? new OffsetClock() : undefined;

// Demo data so the dev server has something to check out.
const deps = createInMemoryDeps({
  clock,
  stock: { 'demo-listing': 5 },
  prices: { 'demo-listing': 10000 },
  listings: [
    {
      id: 'demo-listing',
      eventName: 'The Midnight Orchestra',
      venue: 'Harbor Hall, San Francisco',
      date: '2030-06-14T19:30:00-07:00',
      timeZone: 'America/Los_Angeles',
      section: 'Orchestra Left',
      row: 'F',
      seats: ['12', '13'],
    },
  ],
  paymentBehavior: (process.env.PAYMENT_BEHAVIOR as PaymentBehavior | undefined) ?? 'succeed',
});

serve({ fetch: createApp(deps, devTools && clock ? { devTools: { deps, clock } } : {}).fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
