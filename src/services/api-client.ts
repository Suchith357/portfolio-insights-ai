/**
 * REST client for the PortfolioIQ Express API.
 *
 * The React app NEVER talks to PostgreSQL directly — every read/write goes
 * through this client to `/api/*` on the Node/Express server.
 *
 * Backend responses use the envelope { data, meta? } on success and
 * { error: { code, message, details? } } on failure. ApiError carries the
 * user-safe backend message when provided.
 */
export const API_BASE_URL: string =
  (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ?? "/api";

/** The backend is live; demo data remains available as an offline fallback. */
export const USE_DEMO_DATA: boolean =
  (import.meta.env["VITE_USE_DEMO_DATA"] as string | undefined) === "true";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TOKEN_KEY = "portfolioiq.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/** Generic JSON request against the Express API. Adds the JWT when present. */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await apiRequestWithMeta<T>(path, init);
  return data as T;
}

/** Same as apiRequest but also surfaces the envelope's optional meta block. */
export async function apiRequestWithMeta<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T | null; meta: { total: number; page: number; pageSize: number; pageCount: number } | null }> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError("We couldn't reach the server. Check your connection and try again.", 0);
  }
  const payload = (await res.json().catch(() => null)) as
    | {
        data?: T;
        meta?: { total: number; page: number; pageSize: number; pageCount: number };
        error?: { code?: string; message?: string; details?: unknown };
      }
    | null;

  if (!res.ok || payload?.error) {
    // Backend messages are user-safe; fall back to status-based copy only for
    // network/transport-level failures where no backend message exists.
    const message =
      payload?.error?.message ??
      (res.status === 401
        ? "Your session has expired. Please sign in again."
        : res.status === 403
          ? "You don't have access to this resource."
          : res.status === 404
            ? "We couldn't find what you were looking for."
            : "Something went wrong on our end. Please try again.");
    throw new ApiError(message, res.status);
  }
  return { data: payload?.data ?? null, meta: payload?.meta ?? null };
}

/** Small latency so loading states are exercised while running on demo data. */
export function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
