import type { SupabaseClient } from "@supabase/supabase-js";

// Shared reads and writes for books, reading sessions and notes.

export interface Book {
  id: string;
  name: string;
  author: string | null;
  notes_folder: string | null;
}

export interface Reading {
  session: { id: string; started_at: string; start_page: number | null; end_page: number | null; ended_at: string | null; summary: string | null };
  book: Book;
  note: { id: string; path: string; updated_at?: string } | null;
  page: number | null; // where the reader is, as far as we know
}

const TIME_ZONE = process.env.BART_TIMEZONE ?? "America/Los_Angeles";

// "2026-10-30 18.40", in the reader's time zone; used for note file names
export function stamp(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}.${p.minute}`;
}

export function folderName(title: string) {
  return title.replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "Untitled";
}

// Titles read off a cover vary ("The Chairs Are Where the People Go" vs with its subtitle),
// so match on the main title, case- and punctuation-insensitive.
const key = (s: string) => s.split(":")[0].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const surnames = (s: string | null) => new Set((s ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? []);

export async function findBook(db: SupabaseClient, name: string, author?: string | null): Promise<Book | null> {
  const { data, error } = await db.from("books").select("id, name, author, notes_folder");
  if (error) throw error;
  const k = key(name);
  const authorsAgree = (b: Book) => {
    if (!author || !b.author) return true;
    const a = surnames(author);
    return [...surnames(b.author)].some((w) => a.has(w));
  };
  const same = (b: Book) => {
    const bk = key(b.name ?? "");
    if (!bk || !k) return false;
    if (bk === k) return true;
    const [short, long] = bk.length < k.length ? [bk, k] : [k, bk];
    return short.length >= 10 && long.startsWith(short);
  };
  return (data ?? []).find((b) => same(b) && authorsAgree(b)) ?? null;
}

// For "resume <title>": the library book whose title best overlaps what the reader said
export async function bookBySpokenTitle(db: SupabaseClient, spoken: string): Promise<Book | null> {
  const { data, error } = await db.from("books").select("id, name, author, notes_folder");
  if (error) throw error;
  const words = new Set(key(spoken).split(" ").filter((w) => w.length > 2 && w !== "the"));
  let best: Book | null = null, bestScore = 0;
  for (const b of data ?? []) {
    const score = key(b.name ?? "").split(" ").filter((w) => words.has(w)).length;
    if (score > bestScore) [best, bestScore] = [b, score];
  }
  return bestScore > 0 ? best : null;
}

// The most recent reading session (open or not) with its book and note
export async function currentReading(db: SupabaseClient): Promise<Reading | null> {
  const { data, error } = await db
    .from("reading_sessions")
    .select("id, started_at, start_page, end_page, ended_at, summary, book:books(id, name, author, notes_folder), note:notes(id, path, updated_at)")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { book, note, ...session } = data as unknown as Reading["session"] & { book: Book; note: Reading["note"] | Reading["note"][] };
  return { session, book, note: Array.isArray(note) ? (note[0] ?? null) : note, page: session.end_page ?? session.start_page };
}

// A session note is a header (title, author, started/stopped lines) followed by optional sections:
// "# Quotes" (passages boxed in pen), "# Topics" (underlined), "# Research" (red boxes) and
// "# Pages" (whole pages, book text in quote blocks).
// addToNote puts markdown at the end of its section, creating the section if needed;
// section null means the header.
export type NoteSection = "Quotes" | "Topics" | "Research" | "Pages";
const SECTION = /^# (Quotes|Topics|Research|Pages)\s*$/gm;

export function placeInNote(content: string, section: NoteSection | null, markdown: string) {
  const heads = [...content.matchAll(SECTION)].map((m) => ({ name: m[1], at: m.index! }));
  const block = `\n${markdown.trim()}\n`;
  if (section === null) {
    const at = heads[0]?.at ?? content.length;
    return `${content.slice(0, at).trimEnd()}\n${block}\n${content.slice(at)}`.trimEnd() + "\n";
  }
  const i = heads.findIndex((h) => h.name === section);
  if (i === -1) return `${content.trimEnd()}\n\n# ${section}\n${block}`;
  const end = heads[i + 1]?.at ?? content.length;
  return `${content.slice(0, end).trimEnd()}\n${block}\n${content.slice(end)}`.trimEnd() + "\n";
}

export async function addToNote(db: SupabaseClient, noteId: string, section: NoteSection | null, markdown: string) {
  const { data, error } = await db.from("notes").select("content").eq("id", noteId).single();
  if (error) throw error;
  const { error: e2 } = await db
    .from("notes")
    .update({ content: placeInNote(data.content, section, markdown), updated_at: new Date().toISOString() })
    .eq("id", noteId);
  if (e2) throw e2;
}

// The open reading session as of now: the latest page anything was saved from, and how long ago anything
// happened in it (a save, a question that used a tool, the session starting). Used so that waking Bart up
// again carries on the same session instead of asking what's being read.
export async function readingContext(db: SupabaseClient) {
  const reading = await currentReading(db);
  if (!reading || reading.session.ended_at) return null;
  const [{ data: mark }, { data: run }] = await Promise.all([
    db.from("annotations").select("page, created_at").eq("reading_session_id", reading.session.id).not("page", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("agent_runs").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const times = [reading.session.started_at, reading.note?.updated_at, mark?.created_at, run?.created_at].filter(Boolean).map((t) => Date.parse(t!));
  const last = Math.max(...times.filter((t) => t >= Date.parse(reading.session.started_at)));
  return { ...reading, page: mark?.page ?? reading.page, minutesAgo: Math.round((Date.now() - last) / 60_000) };
}

export async function appendToNote(db: SupabaseClient, noteId: string, markdown: string) {
  const { data, error } = await db.from("notes").select("content").eq("id", noteId).single();
  if (error) throw error;
  const { error: e2 } = await db
    .from("notes")
    .update({ content: `${data.content}${markdown}`, updated_at: new Date().toISOString() })
    .eq("id", noteId);
  if (e2) throw e2;
}
