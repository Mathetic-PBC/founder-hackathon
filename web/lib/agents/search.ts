import type { Agent } from "./types";
import { currentReading } from "../library";

const SEARCH_MODEL = process.env.SEARCH_MODEL ?? "gpt-5.4-mini";

export const searchWeb: Agent = {
  name: "search_web",
  group: "tools",
  description:
    "Look something up on the web. Call it on your own, without being asked, for any factual question you can't answer with confidence: people, places, terms, dates, events, other books, or claims in the book.",
  triggers: ["voice"],
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "What to look up, as a search query" } },
    required: ["query"],
  },
  async run(args, { openai }) {
    const query = String(args.query ?? "").trim();
    const res = await openai.responses.create({
      model: SEARCH_MODEL,
      tools: [{ type: "web_search", search_context_size: "low" }],
      input: `Search the web and answer in one or two short sentences, for someone listening, not reading. No links or citations in the answer.\n\n${query}`,
    });
    const sources = new Set<string>();
    for (const item of res.output) {
      if (item.type !== "message") continue;
      for (const part of item.content) {
        if (part.type !== "output_text") continue;
        for (const a of part.annotations) if (a.type === "url_citation" && sources.size < 3) sources.add(a.title || a.url);
      }
    }
    return { ok: true, answer: res.output_text.trim(), sources: [...sources] };
  },
};

// A slimmed-down Engelbart search over the notes vault: everything for the current book at once,
// or keyword search across every book's notes and saved marks, ranked by how many query terms match.

const MAX_BOOK_CHARS = 12000;

const terms = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2 && !["the", "and", "what", "did", "about", "that", "this", "with", "for"].includes(t));

function snippet(text: string, words: string[]) {
  const lower = text.toLowerCase();
  const hit = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 120);
  return `${start > 0 ? "…" : ""}${text.slice(start, hit + 200).replace(/\s+/g, " ").trim()}…`;
}

export const searchNotes: Agent = {
  name: "search_notes",
  group: "tools",
  description:
    "Look through the reader's own notes: saved pages, quotes, annotations and reading sessions. Call it on your own whenever they ask about something they read, saved or noted ('what did I save about…', 'what was on page 40', 'remind me what he said about…'). scope current_book returns everything for the book they're reading; all_books keyword-searches every book.",
  triggers: ["voice"],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What they're looking for" },
      scope: { type: "string", enum: ["current_book", "all_books"], description: "Default current_book; all_books for other books or when no book is open" },
    },
    required: ["query"],
  },
  async run(args, { db }) {
    const query = String(args.query ?? "").trim();
    const reading = await currentReading(db);

    if (args.scope !== "all_books" && reading) {
      const [{ data: notes }, { data: marks }] = await Promise.all([
        // Newest first, so if the notes are too long to send in full, it's the oldest that get cut
        db.from("notes").select("path, content, updated_at").eq("book_id", reading.book.id).order("updated_at", { ascending: false }),
        db.from("annotations").select("kind, page, text, created_at").eq("book_id", reading.book.id).order("created_at", { ascending: false }).limit(40),
      ]);
      // Photos are links the model can't use; drop them to save room
      let all = (notes ?? []).map((n) => `=== ${n.path}\n${n.content.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, "")}`).join("\n\n");
      const truncated = all.length > MAX_BOOK_CHARS;
      if (truncated) all = `${all.slice(0, MAX_BOOK_CHARS)}\n[…truncated; search with scope all_books and specific words for the rest]`;
      return {
        ok: true,
        book: reading.book.name,
        notes: all || "(no notes yet for this book)",
        marks_newest_first: (marks ?? []).map((m) => `${m.kind}${m.page != null ? ` p.${m.page}` : ""}: ${m.text}`),
        next: "Notes and marks are newest first. Answer the question from them in one or two short sentences. If they don't contain it, say so.",
      };
    }

    const words = terms(query);
    if (!words.length) return { ok: false, reason: "Ask what to look for: a word or phrase." };
    const or = words.map((w) => `content.ilike.%${w}%`).join(",");
    const [{ data: notes, error }, { data: marks }] = await Promise.all([
      db.from("notes").select("path, content, books(name)").or(or).limit(50),
      db.from("annotations").select("kind, page, text, books(name)").or(words.map((w) => `text.ilike.%${w}%`).join(",")).limit(50),
    ]);
    if (error) throw error;
    const score = (text: string) => words.filter((w) => text.toLowerCase().includes(w)).length;
    const hits = [
      ...(notes ?? []).map((n) => ({ book: (n.books as unknown as { name: string } | null)?.name, where: n.path, score: score(n.content), text: snippet(n.content, words) })),
      ...(marks ?? []).map((m) => ({ book: (m.books as unknown as { name: string } | null)?.name, where: `${m.kind}${m.page != null ? ` p.${m.page}` : ""}`, score: score(m.text ?? ""), text: m.text })),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    return {
      ok: true,
      query,
      results: hits.length ? hits : "nothing found",
      next: "Answer from these results in one or two short sentences, naming the book. If nothing matches, say so.",
    };
  },
};
