import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createInMemoryDeps } from './deps';
import type { PaymentBehavior } from './services/payment';

const port = Number(process.env.PORT ?? 3001);

// Demo data so the dev server has something to check out.
const deps = createInMemoryDeps({
  stock: { 'demo-listing': 5 },
  prices: { 'demo-listing': 10000 },
  paymentBehavior: (process.env.PAYMENT_BEHAVIOR as PaymentBehavior | undefined) ?? 'succeed',
});

serve({ fetch: createApp(deps).fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
