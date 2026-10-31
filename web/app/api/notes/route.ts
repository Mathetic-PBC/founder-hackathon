import { supabase, unauthorized } from "@/lib/server";

// The notes vault as a feed, so the Pi can mirror it to disk without holding Supabase keys.
//   GET /api/notes?since=<ISO time>  → { notes: [{ path, content, updated_at, attachments }] }
// path is "<book folder>/<session start>.md". attachments maps each captures/... link in the
// content to a download URL that stays valid for an hour.
export async function GET(req: Request) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const since = new URL(req.url).searchParams.get("since") ?? "1970-01-01T00:00:00Z";
  const db = supabase();
  const { data, error } = await db
    .from("notes")
    .select("path, content, updated_at")
    .gt("updated_at", since)
    .order("updated_at")
    .limit(200);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const notes = await Promise.all(
    (data ?? []).map(async (note) => {
      const links = [...note.content.matchAll(/\]\(captures\/([^)\s]+)\)/g)].map((m) => m[1]);
      const attachments: Record<string, string> = {};
      if (links.length) {
        const { data: signed } = await db.storage.from("captures").createSignedUrls(links, 3600);
        for (const s of signed ?? []) if (s.path && s.signedUrl) attachments[`captures/${s.path}`] = s.signedUrl;
      }
      return { ...note, attachments };
    }),
  );
  return Response.json({ notes });
}
