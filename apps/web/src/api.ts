export type ApiFailure = Error & { status: number; code: string };

let csrfRequest: Promise<string> | undefined;

const configuredApiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
const normalizedApiBaseUrl = configuredApiBaseUrl
  ? (() => {
    const url = new URL(
      configuredApiBaseUrl.includes("://") ? configuredApiBaseUrl : `https://${configuredApiBaseUrl}`,
    );
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path.endsWith("/api") ? path : `${path}/api`}`;
  })()
  : "/api";

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const value = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix))?.slice(prefix.length);
  return value ? decodeURIComponent(value) : undefined;
}

async function csrfToken(): Promise<string> {
  const existing = readCookie("cbh_csrf");
  if (existing) return existing;

  csrfRequest ??= fetch(`${normalizedApiBaseUrl}/auth/csrf`, { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) throw new Error("تعذر تهيئة حماية الطلبات. تحقق من اتصال خادم API.");
      const payload = (await response.json()) as { csrfToken?: string };
      if (!payload.csrfToken) throw new Error("لم يُرجع الخادم رمز حماية الطلب.");
      return payload.csrfToken;
    })
    .finally(() => {
      csrfRequest = undefined;
    });
  return csrfRequest;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-CSRF-Token", await csrfToken());
  }

  let response: Response;
  try {
    response = await fetch(`${normalizedApiBaseUrl}${path}`, {
      method,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("تعذر الاتصال بالخادم. تحقق من تشغيل API وقاعدة البيانات.");
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? (await response.json()) as { error?: string; code?: string }
    : undefined;

  if (!response.ok) {
    const failure = new Error(payload?.error ?? `فشل الطلب (${response.status}).`) as ApiFailure;
    failure.status = response.status;
    failure.code = payload?.code ?? "REQUEST_FAILED";
    throw failure;
  }
  return payload as T;
}
