import { supabase, unauthorized } from "@/lib/server";

// The client posts each finished utterance here; the realtime audio never touches Vercel.
//   POST /api/transcripts  { session_id, role: "user" | "assistant", text }
export async function POST(req: Request) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { session_id, role, text } = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!session_id || !text || (role !== "user" && role !== "assistant")) {
    return Response.json({ error: "need session_id, role (user|assistant) and text" }, { status: 400 });
  }
  const { error } = await supabase().from("transcripts").insert({ session_id, role, text });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
