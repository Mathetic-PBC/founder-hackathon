import type { Agent } from "./types";
import { addToNote, currentReading } from "../library";
import { PhotonError, sendIMessages } from "../photon";
import { actOnMarks, pageLabel, spokenSummary } from "./marks";
import { readMarks, type Mark } from "./vision";

// Every photo tool here reads the reader's pen marks and acts on them (lib/agents/marks.ts):
// boxes are saved as quotes, underlines as topics, red marks are researched.

// An unusable photo leaves the camera on and asks for another; anything else turns it off
const retryPhoto = (tool: string, why: string) => ({
  ok: false,
  retry: true,
  reason: why,
  next: `${why} The camera is still on. Ask the reader to hold the page steady and say "take the photo" again, then call ${tool} again.`,
});

// The reply after a photo; when the printed page number wasn't in the photo, it also asks for it
const withPageQuestion = (summary: string, page: number | null) =>
  page != null
    ? `Reply only: "${summary}"`
    : `Reply only: "${summary} I couldn't see the page number. What page is it?" Then call set_page with their answer.`;

export const saveToNotes: Agent = {
  name: "save_to_notes",
  group: "tools",
  description:
    "Act on the reader's pen marks on the page: a box saves that quote, an underline saves it as a topic, a red underline gets a quick spoken answer, a red box gets researched and saved. Use for 'save this quote', 'save what I marked', 'look at what I marked', 'look this up' about marked text, or similar. Never for sending anything to a person: if they say share, send or text, or name someone, use share_with_friend.",
  triggers: ["voice"],
  needsImage: { countdown: 0 },
  async run(_args, { image, openai, db, runId }) {
    if (!image) return retryPhoto("save_to_notes", "No photo came through.");
    const [scan, reading] = await Promise.all([readMarks(openai, image), currentReading(db)]);
    if (!scan.marks.length) return retryPhoto("save_to_notes", "I couldn't see any pen marks.");
    // Only the page number printed in the photo counts; if it isn't visible, ask rather than guess
    const page = scan.page;
    const acts = await actOnMarks(db, reading, scan.marks, page, image, runId);
    return { ok: true, camera: "off", page, page_unknown: page == null, ...acts, next: withPageQuestion(spokenSummary(acts), page) };
  },
};

export const shareWithFriend: Agent = {
  name: "share_with_friend",
  group: "tools",
  description:
    "Send what the reader marked on the page to a person in their contacts by iMessage. Use whenever they say share, send or text something with or to someone ('share what I marked with David', 'send this to Hudson'). Each boxed, underlined or highlighted passage goes as its own message, then their handwritten annotations in one more message. Also saved to their notes, and red marks are researched as usual.",
  triggers: ["voice"],
  needsImage: { countdown: 0 },
  parameters: {
    type: "object",
    properties: { friend: { type: "string", description: "Name of the person to send it to, e.g. David" } },
    required: ["friend"],
  },
  async run(args, { image, openai, db, runId }) {
    if (!image) return retryPhoto("share_with_friend", "No photo came through.");
    const friend = String(args.friend ?? "").trim();
    // The contact lookup and reading context run while the model reads the photo
    const [scan, contacts, reading] = await Promise.all([
      readMarks(openai, image),
      db.from("contacts").select("id, name, phone").ilike("name", `%${friend}%`),
      currentReading(db),
    ]);
    if (contacts.error) throw contacts.error;
    const contact = contacts.data?.[0];
    if (!contact) {
      const { data: all } = await db.from("contacts").select("name");
      return { ok: false, camera: "off", reason: `No contact named ${friend}. Contacts: ${(all ?? []).map((c) => c.name).join(", ") || "none"}.` };
    }

    // One message per marked passage, in page order as the model listed them; then the annotations together:
    // margin notes plus any comment written next to a marked passage. Sent even if the reader didn't ask.
    const passages = scan.marks.filter((m) => m.shape === "box" || m.shape === "underline" || m.shape === "highlight");
    const annotations = [
      ...scan.marks.filter((m) => m.shape === "margin_note" || m.shape === "other").map((m) => m.text),
      ...passages.filter((m) => m.note).map((m) => `${m.note} (on "${m.text}")`),
    ];
    if (!passages.length && !annotations.length) {
      return retryPhoto("share_with_friend", "I couldn't find anything boxed, underlined or written on the page.");
    }

    const page = scan.page;
    const acts = await actOnMarks(db, reading, scan.marks, page, image, runId, contact.name);
    const source = reading ? `${reading.book.name.split(":")[0]}${page != null ? `, p. ${page}` : ""}` : page != null ? `p. ${page}` : null;
    const texts = [
      ...passages.map((m, i) => `“${m.text}”${i === 0 && source ? `\n— ${source}` : ""}`),
      ...(annotations.length ? [`My notes${!passages.length && source ? ` (${source})` : ""}:\n${annotations.map((a) => `- ${a}`).join("\n")}`] : []),
    ];

    const log = { contact_id: contact.id, to_name: contact.name, to_phone: contact.phone, agent_run_id: runId };
    let ids: string[];
    try {
      ids = await sendIMessages(contact.phone, texts, `bart-share:${runId}`);
    } catch (err) {
      if (!(err instanceof PhotonError)) throw err;
      await db.from("messages").insert(texts.map((body) => ({ ...log, body, status: "error", error: err.message })));
      return { ok: false, camera: "off", ...acts, reason: `Saved to notes, but the texts to ${contact.name} didn't go out. ${err.message}` };
    }
    await db.from("messages").insert(texts.map((body, i) => ({ ...log, body, status: "sent", provider_message_id: ids[i] })));
    const n = texts.length;
    return {
      ok: true,
      camera: "off",
      sent_to: contact.name,
      messages: n,
      page,
      page_unknown: page == null,
      ...acts,
      next: withPageQuestion(spokenSummary({ ...acts, quotes: [], topics: [] }, `Taken. Sent ${n} message${n === 1 ? "" : "s"} to ${contact.name}.`), page),
    };
  },
};

// "Save this page": the whole page's text in a quote block plus the reader's marks as plain text,
// under "# Pages" in this session's note; the marks are also acted on like any other photo.

const MARK_LABEL: Record<Mark["shape"], string> = {
  underline: "Underlined",
  highlight: "Highlighted",
  box: "Boxed",
  margin_note: "Margin note",
  other: "Marked",
};

export const savePage: Agent = {
  name: "save_page",
  group: "voice",
  description:
    "Save the whole page the reader is on: all of its text plus their marks (underlines, highlights, boxes, margin notes) into this session's notes, and act on the marks. Use for 'save this page', 'upload this page' or similar.",
  triggers: ["voice"],
  needsImage: { countdown: 3 },
  async run(_args, { image, openai, db, runId }) {
    if (!image) return retryPhoto("save_page", "No photo came through.");
    const [scan, reading] = await Promise.all([readMarks(openai, image, { fullText: true }), currentReading(db)]);
    if (!scan.text) return retryPhoto("save_page", "I couldn't read the page. It needs to be flat, close and in focus.");
    const page = scan.page;
    const acts = await actOnMarks(db, reading, scan.marks, page, image, runId);
    if (!reading?.note) {
      return { ok: true, camera: "off", page, ...acts, next: 'Reply only: "Taken. Sync the book first so I can put pages in a note."' };
    }

    const quoted = scan.text.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
    const marks = scan.marks
      .map((m) => `- ${m.color === "red" ? "Red " + MARK_LABEL[m.shape].toLowerCase() : MARK_LABEL[m.shape]}: ${m.shape === "margin_note" ? m.text : `"${m.text}"`}${m.note ? ` (${m.note})` : ""}`)
      .join("\n");
    const label = pageLabel(page);
    await addToNote(db, reading.note.id, "Pages", `## ${label}\n\n${quoted}\n\n${marks ? `${marks}\n\n` : ""}![${label}](captures/${image.path})`);
    return { ok: true, camera: "off", page, page_unknown: page == null, note: reading.note.path, ...acts, next: withPageQuestion(spokenSummary(acts, "Taken.", page != null ? label : "the page"), page) };
  },
};

// Rewrites one save's page label in a note: its chunks (quote or page) end with its photo link, and run from
// the end of the previous photo link or section heading; its topics are lines "- <topic> (<label>)".
export function relabel(content: string, imagePath: string, topics: string[], from: string, to: string) {
  const link = `](captures/${imagePath})`;
  for (let at = content.indexOf(link); at !== -1; at = content.indexOf(link, at + link.length)) {
    const start = Math.max(content.lastIndexOf("](captures/", at - 1), content.lastIndexOf("\n# ", at), 0);
    const before = content.slice(start, at).split(from).join(to);
    content = content.slice(0, start) + before + content.slice(at);
    at = start + before.length;
  }
  for (const topic of topics) {
    const line = `- ${topic} (${from})`;
    const i = content.lastIndexOf(line);
    if (i !== -1) content = content.slice(0, i) + `- ${topic} (${to})` + content.slice(i + line.length);
  }
  return content;
}

// "What page is it?" → "82": puts the page on the last photo save, in the annotations and in the note.
// That save's note text is found by its photo link (quote and page chunks end with it) and its topic lines.
export const setPage: Agent = {
  name: "set_page",
  group: "tools",
  description:
    "Set the page number of the last thing saved from a photo: when its page number wasn't visible and the reader tells you, or when they correct it ('that was page 82').",
  triggers: ["voice"],
  parameters: { type: "object", properties: { page: { type: "integer", description: "The page number" } }, required: ["page"] },
  async run(args, { db }) {
    const page = Number(args.page);
    const { data: run } = await db
      .from("agent_runs")
      .select("id, result, image_path")
      .in("agent", ["save_page", "save_to_notes", "share_with_friend"])
      .eq("status", "done")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!run?.image_path) return { ok: false, reason: "There's no saved photo to put a page number on." };
    const result = (run.result ?? {}) as { page?: number | null; topics?: string[] };
    const from = pageLabel(result.page ?? null);
    const to = pageLabel(page);

    await db.from("annotations").update({ page }).eq("agent_run_id", run.id);
    const reading = await currentReading(db);
    if (reading?.note && from !== to) {
      const { data: note } = await db.from("notes").select("content").eq("id", reading.note.id).single();
      const content = relabel(note?.content ?? "", run.image_path, result.topics ?? [], from, to);
      await db.from("notes").update({ content, updated_at: new Date().toISOString() }).eq("id", reading.note.id);
    }
    await db.from("agent_runs").update({ result: { ...result, page, page_unknown: false } }).eq("id", run.id);
    return { ok: true, page, next: `Reply only: "Page ${page}."` };
  },
};
