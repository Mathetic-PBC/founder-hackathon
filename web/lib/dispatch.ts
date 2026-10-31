import { after } from "next/server";
import { getAgent } from "./agents";
import type { Capture, Trigger } from "./agents/types";
import { openai, supabase } from "./server";

export interface DispatchRequest {
  agent: string;
  args: Record<string, unknown>;
  trigger: Trigger;
  sessionId: string | null;
  client?: string | null;
  callId?: string | null;
  image?: { bytes: Buffer; mime: string } | null;
}

export interface DispatchResult {
  run_id: string | null;
  status: "running" | "done" | "error" | "not_implemented";
  result?: unknown;
  error?: string;
}

// Every agent call, from any trigger, goes through here: log the run, store the
// photo, run the agent (inline, or after the response if it's async), record the outcome.
export async function dispatch(req: DispatchRequest): Promise<DispatchResult> {
  const agent = getAgent(req.agent);
  if (!agent) return { run_id: null, status: "error", error: `unknown agent: ${req.agent}` };
  if (req.trigger !== "http" && !agent.triggers.includes(req.trigger)) {
    return { run_id: null, status: "error", error: `${agent.name} can't be triggered by ${req.trigger}` };
  }

  const db = supabase();
  // Clients make up their own session id (one per conversation); register it on first use
  if (req.sessionId) {
    const { error } = await db.from("sessions").upsert({ id: req.sessionId, client: req.client ?? "pi" }, { ignoreDuplicates: true });
    if (error) throw new Error(`sessions upsert failed: ${error.message}`);
  }
  const { data: run, error } = await db
    .from("agent_runs")
    .insert({ session_id: req.sessionId, agent: agent.name, trigger: req.trigger, call_id: req.callId ?? null, args: req.args })
    .select("id")
    .single();
  if (error) throw new Error(`agent_runs insert failed: ${error.message}`);
  const runId: string = run.id;

  let image: Capture | null = null;
  if (req.image) {
    const ext = req.image.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
    const path = `${req.sessionId ?? "no-session"}/${runId}.${ext}`;
    const up = await db.storage.from("captures").upload(path, req.image.bytes, { contentType: req.image.mime });
    if (up.error) throw new Error(`capture upload failed: ${up.error.message}`);
    await db.from("agent_runs").update({ image_path: path }).eq("id", runId);
    image = { ...req.image, path };
  }

  const finish = (fields: Omit<DispatchResult, "run_id">) =>
    db
      .from("agent_runs")
      .update({ status: fields.status, result: fields.result ?? null, error: fields.error ?? null, finished_at: new Date().toISOString() })
      .eq("id", runId)
      .then(() => ({ run_id: runId, ...fields }));

  if (!agent.run) {
    return finish({ status: "not_implemented", result: { message: `The ${agent.name} agent isn't built yet.` } });
  }

  const run$ = async (): Promise<DispatchResult> => {
    try {
      const result = await agent.run!(req.args, { runId, sessionId: req.sessionId, trigger: req.trigger, image, db, openai: openai() });
      return finish({ status: "done", result });
    } catch (err) {
      console.error(`agent ${agent.name} failed`, err);
      return finish({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (agent.async) {
    after(run$);
    return { run_id: runId, status: "running" };
  }
  return run$();
}
