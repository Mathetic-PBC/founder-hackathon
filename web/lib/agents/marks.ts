import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, Capture } from "./types";
import { addToNote, currentReading, type Reading } from "../library";
import type { Mark } from "./vision";

// What the reader's pen marks mean, on any photo except a book cover. Dark is black, blue or pencil.
//   dark box        → save the quote            (# Quotes)
//   dark underline  → save it as a topic        (# Topics)
//   red underline   → quick research (≤20 s), spoken when ready
//   red box         → thorough research, saved  (# Research) and summarized aloud
//   highlighter, margin notes → kept as annotations
// Research runs on the device's own time: results list what to research, and the device calls
// the research agent in the background so the conversation isn't held up.

export interface ResearchRequest {
  topic: string;
  context: string | null;
  depth: "quick" | "thorough";
}

export interface MarkActions {
  quotes: string[];
  topics: string[];
  research: ResearchRequest[];
  inNote: boolean;
}

const kindOf = (m: Mark) =>
  m.color === "red" ? "citation" : m.shape === "box" ? "quote" : m.shape === "underline" || m.shape === "highlight" ? "excerpt" : "annotation";

export async function actOnMarks(
  db: SupabaseClient,
  reading: Reading | null,
  marks: Mark[],
  page: number | null,
  image: Capture,
  runId: string,
  sharedWith?: string,
): Promise<MarkActions> {
  const quotes = marks.filter((m) => m.color === "dark" && m.shape === "box");
  const topics = marks.filter((m) => m.color === "dark" && m.shape === "underline");
  const research = marks.filter((m) => m.color === "red" && (m.shape === "underline" || m.shape === "box"));

  if (marks.length) {
    await db.from("annotations").insert(
      marks.map((m) => ({
        book_id: reading?.book.id ?? null,
        reading_session_id: reading?.session.id ?? null,
        kind: kindOf(m),
        page,
        text: m.note ? `${m.text} — ${m.note}` : m.text,
        image_path: image.path,
        agent_run_id: runId,
      })),
    );
  }

  const note = reading?.note;
  if (note && quotes.length) {
    const meta = [page != null ? `p. ${page}` : null, sharedWith ? `shared with ${sharedWith}` : null].filter(Boolean).join(" · ");
    const blocks = quotes.map((q) => q.text.split("\n").map((l) => `> ${l}`).join("\n")).join("\n\n");
    // captures/... links are downloaded next to the note by pi/vault.py
    await addToNote(db, note.id, "Quotes", `${blocks}\n\n${meta ? `— ${meta}\n\n` : ""}![${meta || "photo"}](captures/${image.path})`);
  }
  if (note && topics.length) {
    await addToNote(db, note.id, "Topics", topics.map((t) => `- ${t.text}${page != null ? ` (p. ${page})` : ""}`).join("\n"));
  }

  return {
    quotes: quotes.map((q) => q.text),
    topics: topics.map((t) => t.text),
    research: research.map((r) => ({ topic: r.text, context: r.context, depth: r.shape === "box" ? "thorough" : "quick" })),
    inNote: !!note,
  };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The one short line the model says after a photo, e.g. "Taken. Saved 1 quote and 2 topics. Looking up stoicism."
export function spokenSummary(acts: MarkActions, lead = "Taken.", alsoSaved?: string) {
  const saved = [alsoSaved, acts.quotes.length && count(acts.quotes.length, "quote"), acts.topics.length && count(acts.topics.length, "topic")].filter(Boolean) as string[];
  const looking = acts.research.map((r) => r.topic.split(/\s+/).slice(0, 6).join(" "));
  return [
    lead,
    saved.length ? `Saved ${saved.length > 1 ? `${saved.slice(0, -1).join(", ")} and ${saved.at(-1)}` : saved[0]}.` : "",
    looking.length ? `Looking up ${looking.join(" and ")}.` : "",
    (acts.quotes.length || acts.topics.length) && !acts.inNote ? "Sync the book to put these in a note." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const QUICK_MODEL = process.env.SEARCH_MODEL ?? "gpt-5.4-mini";
const THOROUGH_MODEL = process.env.RESEARCH_MODEL ?? "gpt-6.1-terra";

export const research: Agent = {
  name: "research",
  group: "highlight",
  description:
    "Research something the reader marked in red. quick (red underline): a one- or two-sentence answer within 20 seconds. thorough (red box): a research note saved to this session's notes, plus a one-sentence summary.",
  // Not a voice tool: the device calls it in the background after a photo with red marks
  triggers: [],
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string" },
      context: { type: "string", description: "The sentence the mark is in" },
      depth: { type: "string", enum: ["quick", "thorough"] },
    },
    required: ["topic", "depth"],
  },
  async run(args, { openai, db }) {
    const topic = String(args.topic ?? "").trim();
    const context = typeof args.context === "string" && args.context.trim() ? args.context.trim() : null;
    const reading = await currentReading(db);
    const where = [
      reading ? `while reading "${reading.book.name}"${reading.book.author ? ` by ${reading.book.author}` : ""}` : null,
      context ? `in the sentence: "${context}"` : null,
    ].filter(Boolean).join(", ");
    const ask = `A reader marked "${topic}"${where ? ` ${where}` : ""}.`;

    if (args.depth !== "thorough") {
      try {
        const res = await openai.responses.create(
          {
            model: QUICK_MODEL,
            tools: [{ type: "web_search", search_context_size: "low" }],
            input: `${ask} Explain what it is or means in one short sentence (under 20 words), for someone listening. No links or citations.`,
          },
          { timeout: 18_000, maxRetries: 0 },
        );
        return { ok: true, topic, answer: res.output_text.trim() };
      } catch {
        return { ok: false, topic, answer: null, reason: "Couldn't find an answer within 20 seconds." };
      }
    }

    const res = await openai.responses.create(
      {
        model: THOROUGH_MODEL,
        tools: [{ type: "web_search", search_context_size: "medium" }],
        input: `${ask} Research it thoroughly on the web: what it is, why it matters here, and anything the reader would want to know next.`,
        text: {
          format: {
            type: "json_schema",
            name: "research",
            strict: true,
            schema: {
              type: "object",
              properties: {
                spoken: { type: "string", description: "One short sentence summarizing the finding, to be read aloud" },
                note: { type: "string", description: "A concise research note in markdown: 4 to 8 bullet points" },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { title: { type: "string" }, url: { type: "string" } },
                    required: ["title", "url"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["spoken", "note", "sources"],
              additionalProperties: false,
            },
          },
        },
      },
      { timeout: 120_000, maxRetries: 0 },
    );
    const found = JSON.parse(res.output_text) as { spoken: string; note: string; sources: { title: string; url: string }[] };
    const sources = found.sources.slice(0, 5).map((s) => `- [${s.title}](${s.url})`).join("\n");
    if (reading?.note) {
      await addToNote(db, reading.note.id, "Research", `## ${topic}\n\n${found.note.trim()}${sources ? `\n\nSources:\n\n${sources}` : ""}`);
    }
    return { ok: true, topic, answer: found.spoken, saved: reading?.note?.path ?? null };
  },
};
