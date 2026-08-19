import type {
  ApiErrorBody,
  ApiErrorCode,
  CharacterCreateInput,
  CharacterDto,
  MeResponse,
  ReferenceResponse,
  RefreshResponse,
  SessionResponse,
  UsernameAvailabilityResponse,
} from '@lethalmagotchi/shared';

const BASE = '/api/v1';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields: Record<string, string>;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code;
    this.fields = body.fields ?? {};
    this.retryAfterSeconds = body.retryAfterSeconds;
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Cannot reach the server. Check your connection and try again.');
    this.name = 'NetworkError';
  }
}

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  retryOnUnauthorized?: boolean;
  signal?: AbortSignal;
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  try {
    return await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new NetworkError();
  }
}

async function toError(response: Response): Promise<ApiRequestError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  return new ApiRequestError(
    response.status,
    body?.error ?? { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
  );
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawRequest(path, options);

  if (response.status === 401 && options.retryOnUnauthorized !== false && options.auth !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) response = await rawRequest(path, options);
  }

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

let refreshInFlight: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  // Refresh tokens rotate and reuse trips server-side family revocation, so concurrent
  // callers must share one rotation rather than each presenting the same token.
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function performRefresh(): Promise<boolean> {
  try {
    const response = await rawRequest('/auth/refresh', { method: 'POST', auth: false });
    if (!response.ok) {
      accessToken = null;
      return false;
    }
    const payload = (await response.json()) as RefreshResponse;
    accessToken = payload.accessToken;
    return true;
  } catch {
    accessToken = null;
    return false;
  }
}

export const api = {
  register(input: { username: string; password: string }): Promise<SessionResponse> {
    return request<SessionResponse>('/auth/register', {
      method: 'POST',
      body: input,
      auth: false,
      retryOnUnauthorized: false,
    });
  },

  login(input: { username: string; password: string }): Promise<SessionResponse> {
    return request<SessionResponse>('/auth/login', {
      method: 'POST',
      body: input,
      auth: false,
      retryOnUnauthorized: false,
    });
  },

  logout(): Promise<void> {
    return request<void>('/auth/logout', { method: 'POST', auth: false, retryOnUnauthorized: false });
  },

  async restoreSession(): Promise<MeResponse | null> {
    const refreshed = await tryRefresh();
    if (!refreshed) return null;
    return request<MeResponse>('/me', { retryOnUnauthorized: false });
  },

  me(): Promise<MeResponse> {
    return request<MeResponse>('/me');
  },

  reference(): Promise<ReferenceResponse> {
    return request<ReferenceResponse>('/reference', { auth: false });
  },

  usernameAvailable(username: string, signal?: AbortSignal): Promise<UsernameAvailabilityResponse> {
    return request<UsernameAvailabilityResponse>(
      `/auth/username-available?username=${encodeURIComponent(username)}`,
      { auth: false, ...(signal ? { signal } : {}) },
    );
  },

  createCharacter(input: CharacterCreateInput): Promise<{ character: CharacterDto }> {
    return request<{ character: CharacterDto }>('/characters', { method: 'POST', body: input });
  },
};
