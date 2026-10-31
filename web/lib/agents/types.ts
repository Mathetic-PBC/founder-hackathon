import type OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";

// voice: the realtime model calls it as a tool.
// highlight: it can be bound to a highlighter color (highlighter_bindings).
// http: a direct POST to /api/agents/:name (always allowed; for testing).
export type Trigger = "voice" | "highlight" | "http";

export interface Capture {
  bytes: Buffer;
  mime: string;
  path: string; // object path in the `captures` Storage bucket
}

export interface AgentContext {
  runId: string;
  sessionId: string | null;
  trigger: Trigger;
  image: Capture | null;
  db: SupabaseClient;
  openai: OpenAI;
}

export interface Agent {
  name: string;
  // Section of the Agents note it comes from
  group: "highlight" | "voice" | "tools";
  // What the realtime model reads to decide when to call it
  description: string;
  // JSON Schema for the arguments
  parameters?: Record<string, unknown>;
  triggers: Trigger[];
  // The client must capture a photo and attach it before dispatch: after a countdown of
  // that many seconds, or with 0, right away (the reader already said "take the photo")
  needsImage?: { countdown: number };
  // Runs after the HTTP response; the client polls /api/runs/:id for the result
  async?: boolean;
  // Unset = not built yet; dispatch logs the call and answers "not_implemented"
  run?: (args: Record<string, unknown>, ctx: AgentContext) => Promise<unknown>;
}
