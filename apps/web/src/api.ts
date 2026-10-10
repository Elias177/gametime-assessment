import type { CheckoutSession, Listing } from '@checkout/shared';

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
async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(path, init);
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

export const getSession = (id: string) => call<CheckoutSession>(`/api/sessions/${id}`);

export const getListing = (id: string) => call<Listing>(`/api/listings/${id}`);

export const acknowledgeSession = (id: string, version: number) =>
  call<CheckoutSession>(`/api/sessions/${id}/acknowledge`, post({ version }));

export const completeSession = (id: string, idempotencyKey: string, version: number) =>
  call<SessionResponse>(
    `/api/sessions/${id}/complete`,
    post({ version }, { 'Idempotency-Key': idempotencyKey }),
  );

export const createSession = (listingId: string) => call<CheckoutSession>('/api/sessions', post({ listingId }));
