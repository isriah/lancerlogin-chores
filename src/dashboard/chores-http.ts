// Requests to this plugin's Worker routes. These behave like the SDK's `dashboardApi` (same base, session cookie, JSON body)
// and also keep the `code` and `field` of a refusal, which `dashboardApi` drops, so the page can point at the right picker.
import { dashboardApi, dashboardApiBaseUrl } from "@lancerlogin/module-sdk/dashboard";

export const setupRoute = "/module-setup/chores";
export const adminRoute = "/admin/chores";

export class RequestError extends Error {
  readonly status: number; readonly code: string | undefined; readonly field: string | undefined;
  constructor(message: string, status: number, code?: string, field?: string) {
    super(message);
    this.name = "RequestError"; this.status = status; this.code = code; this.field = field;
  }
}

export const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export async function request<T>(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${dashboardApiBaseUrl}${path}`, { method, credentials: "include", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new RequestError("The server could not be reached. Check your connection and try again.", 0); }
  const parsed = await response.json().catch(() => ({})) as T & { error?: string; code?: string; field?: string };
  if (!response.ok) throw new RequestError(parsed.error ?? "That did not work. Try again.", response.status, parsed.code, parsed.field);
  return parsed;
}

/** Tell Core a setup step passed. It opens the module once every required step has, and is harmless afterwards. */
export async function recordSetupStep(stepId: "notion-connection" | "person-write-check"): Promise<void> {
  const path = "/admin/modules/chores/setup";
  const { generation } = await dashboardApi<{ generation: number }>(path);
  await dashboardApi(path, { method: "PUT", body: JSON.stringify({ generation, stepId, outcome: "completed" }) });
}
