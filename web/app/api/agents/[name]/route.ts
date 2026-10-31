import { dispatch } from "@/lib/dispatch";
import { obj, readBody, str } from "@/lib/http";
import { unauthorized } from "@/lib/server";

// Run one agent.
//   POST /api/agents/:name  JSON { args, session_id?, call_id?, client? }
//                           or multipart with the same fields (args as a JSON string) + image
//   → { run_id, status: done | running | not_implemented | error, result?, error? }
// A call_id means the realtime model asked for it (trigger "voice"); otherwise it's a direct "http" call.

export const maxDuration = 300;

export async function POST(req: Request, ctx: RouteContext<"/api/agents/[name]">) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { name } = await ctx.params;

  try {
    const { fields, image } = await readBody(req);
    const callId = str(fields.call_id);
    const out = await dispatch({
      agent: name,
      args: obj(fields.args),
      trigger: callId ? "voice" : "http",
      sessionId: str(fields.session_id),
      client: str(fields.client),
      callId,
      image,
    });
    return Response.json(out, { status: out.run_id ? 200 : 400 });
  } catch (err) {
    console.error(`dispatch ${name} failed`, err);
    return Response.json({ run_id: null, status: "error", error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
