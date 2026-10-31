import { dispatch } from "@/lib/dispatch";
import { readBody, str } from "@/lib/http";
import { supabase, unauthorized } from "@/lib/server";

// A highlighter stroke was seen: run whichever agent that color is bound to.
//   POST /api/highlight  JSON or multipart { color, session_id?, text? } + image (the highlighted region)
//   → the dispatch result, plus the agent it ran
// Bindings live in the highlighter_bindings table; the bind_highlighter voice tool rewrites them.

export const maxDuration = 300;

export async function POST(req: Request) {
  const denied = unauthorized(req);
  if (denied) return denied;

  try {
    const { fields, image } = await readBody(req);
    const color = str(fields.color)?.toLowerCase().trim();
    if (!color) return Response.json({ error: "missing color" }, { status: 400 });

    const { data: binding, error } = await supabase()
      .from("highlighter_bindings")
      .select("agent")
      .eq("color", color)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!binding) return Response.json({ error: `no agent bound to ${color}` }, { status: 404 });

    const out = await dispatch({
      agent: binding.agent,
      args: { color, text: str(fields.text) },
      trigger: "highlight",
      sessionId: str(fields.session_id),
      image,
    });
    return Response.json({ agent: binding.agent, ...out });
  } catch (err) {
    console.error("highlight failed", err);
    return Response.json({ status: "error", error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}
