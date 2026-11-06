/** Typed gateway client for web and agent. Parses every response with zod; no keys involved. */
import { z } from "zod";
import { AgentMeterError } from "./errors";
import { AgentView, AuditRow, DeviceView, ErrorBody, SessionView } from "./schemas";

export function createGatewayClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/$/, "");

  async function get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
    const res = await fetchImpl(`${base}${path}`, { headers: { accept: "application/json" } });
    const body: unknown = await res.json();
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(body);
      if (parsed.success) {
        const { code, message, sessionId } = parsed.data.error;
        throw new AgentMeterError(code, message, sessionId);
      }
      throw new AgentMeterError("INTERNAL", `gateway ${res.status}`);
    }
    return schema.parse(body);
  }

  return {
    session: (id: string) => get(`/sessions/${encodeURIComponent(id)}`, SessionView),
    devices: () => get("/devices", z.array(DeviceView)),
    agents: () => get("/agents", z.array(AgentView)),
    audit: (limit = 50) => get(`/audit?limit=${limit}`, z.array(AuditRow)),
  };
}
export type GatewayClient = ReturnType<typeof createGatewayClient>;
