import { supabase, unauthorized } from "@/lib/server";

// GET /api/runs/:id → the agent run row; clients poll this for async agents
export async function GET(req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const { data, error } = await supabase()
    .from("agent_runs")
    .select("id, agent, status, result, error, created_at, finished_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(data);
}
