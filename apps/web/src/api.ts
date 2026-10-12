import type { CheckoutSession, Listing, Surface } from '@checkout/shared';

/** Who is calling: one `clientId` per pane/device, sent with every request for analytics later. */
export interface ClientInfo {
  clientId: string;
  surface: Surface;
}

const clientHeaders = ({ clientId, surface }: ClientInfo): Record<string, string> => ({
  'X-Client-Id': clientId,
  'X-Surface': surface,
});

/** EventSource can't set headers, so the stream identifies its client in the query string. */
export const eventsUrl = (id: string, { clientId, surface }: ClientInfo) =>
  `/api/sessions/${id}/events?${new URLSearchParams({ clientId, surface })}`;

export interface ApiError {
  code: string;
  message: string;
}

/** Body of every non-2xx response; `session` is the fresh state when the server has one to show. */
export interface ApiErrorBody {
  error: ApiError;
  session?: CheckoutSession;
}

/** A session returned by `/complete`; `completedElsewhere` is set when another device already paid. */
export type SessionResponse = CheckoutSession & { completedElsewhere?: true };

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: ApiErrorBody | undefined };

/** Resolves with the HTTP outcome for any response; rejects only on network failure. */
async function call<T>(path: string, client: ClientInfo | undefined, init: RequestInit = {}): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(client && clientHeaders(client)) },
  });
  const body: unknown = await res.json().catch(() => undefined);
  return res.ok
    ? { ok: true, status: res.status, body: body as T }
    : { ok: false, status: res.status, body: body as ApiErrorBody | undefined };
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export const getSession = (id: string, client: ClientInfo) => call<CheckoutSession>(`/api/sessions/${id}`, client);

export const getListing = (id: string, client: ClientInfo) => call<Listing>(`/api/listings/${id}`, client);

export const acknowledgeSession = (id: string, version: number, client: ClientInfo) =>
  call<CheckoutSession>(`/api/sessions/${id}/acknowledge`, client, post({ version }));

export const completeSession = (id: string, idempotencyKey: string, version: number, client: ClientInfo) =>
  call<SessionResponse>(
    `/api/sessions/${id}/complete`,
    client,
    post({ version }, { 'Idempotency-Key': idempotencyKey }),
  );

export const createSession = (listingId: string, client: ClientInfo) =>
  call<CheckoutSession>('/api/sessions', client, post({ listingId }));

export type PaymentBehavior = 'succeed' | 'fail' | 'pending';

export interface DevStatus {
  enabled: true;
  paymentBehavior: PaymentBehavior;
  clockOffsetMs: number;
}

/** Dev tools (`/api/dev`) exist only when the server runs with DEV_TOOLS=1; otherwise this is a 404. */
export const getDevStatus = () => call<DevStatus>('/api/dev/status', undefined);

/** Whether the server has dev tools on. False when it doesn't, or can't be reached. */
export async function devToolsOn(): Promise<boolean> {
  try {
    const res = await getDevStatus();
    return res.ok && res.body.enabled;
  } catch {
    return false;
  }
}

/** POST to a dev action, e.g. `devAction('price', {listingId, deltaCents})`. No client headers needed. */
export const devAction = (action: string, body: object = {}) =>
  call<unknown>(`/api/dev/${action}`, undefined, post(body));

/** One server-side analytics event, as `/api/dev/events` returns it. */
export interface AnalyticsEventView {
  name: string;
  sessionId: string;
  timestamp: string;
  source: 'client' | 'system';
  clientId?: string;
  surface?: Surface;
  props: Record<string, unknown>;
}

export interface DeviceGroupStats {
  sessions: number;
  completed: number;
  conversionRate: number | null;
  medianMinutesToComplete: number | null;
}

export interface ConversionMetric {
  crossDevice: DeviceGroupStats;
  singleDevice: DeviceGroupStats;
}

export interface DevEvents {
  events: AnalyticsEventView[];
  metric: ConversionMetric;
}

/** Dev only, like the rest of `/api/dev`. */
export const getDevEvents = () => call<DevEvents>('/api/dev/events', undefined);
