import { manifest, realtimeTools } from "@/lib/agents";
import { toolInstructions } from "@/lib/instructions";
import { readingContext } from "@/lib/library";
import { supabase, unauthorized } from "@/lib/server";

// Everything a realtime client needs to wire up the agents, fetched once per conversation:
//   GET /api/agents → {
//     tools,         // pass as session.tools in the realtime session.update
//     instructions,  // append to the session instructions (tool etiquette + what's being read)
//     agents,        // per agent: needsImage (take a photo before dispatch), async, built
//   }
export async function GET(req: Request) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const reading = await readingContext(supabase()).catch(() => null);
  return Response.json({ tools: realtimeTools(), instructions: toolInstructions(reading), agents: manifest() });
}
