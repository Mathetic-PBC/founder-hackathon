import type OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, Capture } from "./types";
import { addToNote, bookBySpokenTitle, currentReading, findBook, folderName, readingContext, stamp, type Book } from "../library";
import { readCover } from "./vision";

// "Sync with the book": camera on → "take the photo" → countdown → cover photo → find or create the book →
// confirm the page → start a reading session. The model drives the conversation between steps; each result
// tells it what to do next. The camera stays on until a photo yields both title and author (camera: "off").

// An unreadable photo leaves the camera on and asks for another. The reader is never asked to say the
// title: the cover photo is the only way a book gets added.
const retryPhoto = (tool: string, why: string) => ({
  ok: false,
  retry: true,
  reason: why,
  next: `Reply only: "${why} Hold the cover closer and say take the photo." Never ask the reader for the title or author. Call ${tool} again when they say take the photo.`,
});

async function readTitleAndAuthor(tool: string, image: Capture | null, openai: OpenAI) {
  if (!image) return { retry: retryPhoto(tool, "No photo came through.") };
  const cover = await readCover(openai, image);
  if (!cover.name || !cover.author) {
    return { retry: retryPhoto(tool, cover.name ? "I got the title but not the author." : "I couldn't read the cover.") };
  }
  return { cover: cover as { name: string; author: string } };
}

const shortTitle = (name: string) => name.split(":")[0].trim();

// A known book was picked (by cover photo or by name): mark it as the one being read next and ask about the page
async function pickBook(db: SupabaseClient, existing: Book, how: string) {
  await db.from("books").update({ last_synced_at: new Date().toISOString() }).eq("id", existing.id);
  const { data: last } = await db
    .from("reading_sessions")
    .select("start_page, end_page, summary")
    .eq("book_id", existing.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastPage = last?.end_page ?? last?.start_page ?? null;
  const book = { id: existing.id, name: existing.name, author: existing.author };
  if (lastPage == null) {
    return { ok: true, status: how, camera: "off", book, next: `Reply only: "${shortTitle(existing.name)}. What page are you on?" Then call start_reading with their answer.` };
  }
  const about = last?.summary ? `, ${last.summary.replace(/\.$/, "")}` : "";
  return {
    ok: true,
    status: how,
    camera: "off",
    book,
    last_page: lastPage,
    next: `Reply only: "${shortTitle(existing.name)}. Still on page ${lastPage}${about}?" If yes, call start_reading with page ${lastPage}. If no and they don't say where, ask which page, then call start_reading with it.`,
  };
}

export const listBooks: Agent = {
  name: "list_books",
  group: "tools",
  description:
    "The reader's library, most recently read first, to ask whether to add a new book or resume one. Call it when they want to start reading and no session is in progress, or when they ask for a different book or a new session. reason says which.",
  triggers: ["voice"],
  parameters: {
    type: "object",
    properties: { reason: { type: "string", enum: ["start_reading", "new_book", "new_session"], description: "start_reading unless they asked for a new book or a new session" } },
    required: ["reason"],
  },
  async run(args, { db }) {
    // "Let's keep reading" in the middle of a session carries on; only an explicit ask starts something new
    const current = await readingContext(db);
    if (args.reason !== "new_book" && args.reason !== "new_session" && current && current.minutesAgo <= 120) {
      return {
        ok: true,
        continuing: current.book.name,
        page: current.page,
        next: `Reply only: "Back to ${shortTitle(current.book.name)}${current.page != null ? `, page ${current.page}` : ""}." Don't ask anything else.`,
      };
    }
    const { data, error } = await db
      .from("books")
      .select("name, author, last_synced_at, reading_sessions(start_page, end_page, started_at)")
      .order("last_synced_at", { ascending: false, nullsFirst: false })
      .limit(8);
    if (error) throw error;
    const books = (data ?? []).map((b) => {
      const sessions = ((b.reading_sessions ?? []) as { start_page: number | null; end_page: number | null; started_at: string }[]).sort((x, y) =>
        y.started_at.localeCompare(x.started_at),
      );
      return { title: shortTitle(b.name), author: b.author, last_page: sessions[0] ? (sessions[0].end_page ?? sessions[0].start_page) : null };
    });
    if (!books.length) return { ok: true, books, next: 'Reply only: "No books yet. Want to add one?" If yes, call camera_on.' };
    if (args.reason === "new_book") {
      return { ok: true, books, next: "Call camera_on now, without saying anything first." };
    }
    const named = books.slice(0, 3).map((b) => b.title).join(", or ");
    return {
      ok: true,
      books,
      next: `Reply only: "Add a new book, or resume ${named}?" To add: call camera_on, then sync_book after they say take the photo. To resume: call resume_book with the title they say.`,
    };
  },
};

export const resumeBook: Agent = {
  name: "resume_book",
  group: "tools",
  description: "Pick a book already in the reader's library by its title, without the camera, when they say which one to resume.",
  triggers: ["voice"],
  parameters: {
    type: "object",
    properties: { title: { type: "string", description: "The title as the reader said it" } },
    required: ["title"],
  },
  async run(args, { db }) {
    const book = await bookBySpokenTitle(db, String(args.title ?? ""));
    if (!book) return { ok: false, reason: `"${args.title}" isn't in the library.`, next: 'Reply only: "That one isn\'t in your library. Want to add it?" If yes, call camera_on.' };
    // The book of the session that's still going: just carry on, no page question, no new session
    const current = await readingContext(db);
    if (current && current.minutesAgo <= 120 && current.book.id === book.id) {
      return { ok: true, status: "continuing", page: current.page, next: `Reply only: "Back to ${shortTitle(book.name)}${current.page != null ? `, page ${current.page}` : ""}."` };
    }
    return pickBook(db, book, "resumed");
  },
};

export const syncBook: Agent = {
  name: "sync_book",
  group: "tools",
  description:
    "Add or pick up the physical book the reader is holding, from a photo of its cover. Use when they want to add a new book or show you one. Reads the title and author off the cover, then finds the book in the library or adds it.",
  triggers: ["voice"],
  needsImage: { countdown: 3 },
  async run(_args, { image, openai, db }) {
    const { cover, retry } = await readTitleAndAuthor("sync_book", image, openai);
    if (retry) return retry;

    const existing = await findBook(db, cover.name, cover.author);
    if (existing) return pickBook(db, existing, "existing_book");
    const { data: book, error } = await db
      .from("books")
      .insert({ name: cover.name, author: cover.author, cover_path: image!.path, notes_folder: folderName(cover.name), last_synced_at: new Date().toISOString() })
      .select("id, name, author")
      .single();
    if (error) throw error;
    return {
      ok: true,
      status: "new_book",
      camera: "off",
      book,
      next: `Reply only: "Added ${shortTitle(cover.name)}. What page are you on?" Then call start_reading with their answer.`,
    };
  },
};

// The book picked in this flow: the latest successful sync_book or resume_book, if it was recent. Never a
// fallback to whatever was read last, so a failed photo can't quietly start a session on the wrong book.
async function pickedBook(db: SupabaseClient): Promise<Book | null> {
  const { data: run } = await db
    .from("agent_runs")
    .select("agent, status, result, created_at")
    .in("agent", ["sync_book", "resume_book"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const result = run?.result as { ok?: boolean; book?: { id: string } } | null;
  if (!run || run.status !== "done" || !result?.ok || !result.book?.id) return null;
  if (Date.now() - new Date(run.created_at).getTime() > 30 * 60_000) return null;
  const { data: book } = await db.from("books").select("id, name, author, notes_folder").eq("id", result.book.id).maybeSingle();
  return book;
}

export const startReading: Agent = {
  name: "start_reading",
  group: "tools",
  description: "Start a reading session on the book just added or resumed (sync_book or resume_book), at the page the reader confirmed.",
  triggers: ["voice"],
  parameters: {
    type: "object",
    properties: { page: { type: "integer", description: "Page the reader is starting on" } },
    required: ["page"],
  },
  async run(args, { db }) {
    const page = Number(args.page);
    const book = await pickedBook(db);
    if (!book) return { ok: false, reason: "No book picked yet.", next: 'Reply only: "Which book? Add a new one or resume one?" Then call list_books.' };

    const now = new Date();
    // Only one sitting at a time: close any that were left open
    await db.from("reading_sessions").update({ ended_at: now.toISOString() }).is("ended_at", null);
    const { data: session, error } = await db
      .from("reading_sessions")
      .insert({ book_id: book.id, start_page: page })
      .select("id")
      .single();
    if (error) throw error;

    const path = `${book.notes_folder ?? folderName(book.name)}/${stamp(now)}.md`;
    const content = `# ${book.name}\n\n${book.author ? `*${book.author}*\n\n` : ""}Started on page ${page}, ${stamp(now)}.\n`;
    const { error: noteError } = await db.from("notes").insert({ book_id: book.id, reading_session_id: session.id, path, content });
    if (noteError) throw noteError;
    return { ok: true, book: book.name, page, note: path, next: `Reply only: "Page ${page}. Happy reading."` };
  },
};

// The book text and quotes saved this session (the note's # Pages and # Quotes sections), without photos
async function sessionText(db: SupabaseClient, noteId: string) {
  const { data } = await db.from("notes").select("content").eq("id", noteId).single();
  const content: string = data?.content ?? "";
  const at = content.search(/^# (Quotes|Topics|Research|Pages)\s*$/m);
  return at < 0 ? "" : content.slice(at).replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
}

async function whereTheyStopped(openai: OpenAI, text: string) {
  const res = await openai.responses.create({
    model: process.env.SEARCH_MODEL ?? "gpt-5.4-mini",
    input: `These are pages and passages a reader saved while reading. In three to six words, what is the text about at the end? Reply with just the phrase, lowercase, no period.\n\n${text.slice(-4000)}`,
  });
  return res.output_text.trim().replace(/[."]+$/g, "") || null;
}

export const endReading: Agent = {
  name: "end_reading",
  group: "tools",
  description: "End the current reading session: record the page the reader stopped on, for the reading log.",
  triggers: ["voice"],
  parameters: {
    type: "object",
    properties: {
      page: { type: "integer", description: "Page the reader stopped on" },
      summary: {
        type: "string",
        description: "Only if the conversation made clear what was happening around that page: a short phrase like 'the benches in Dundas Square'. Otherwise leave it out; it's worked out from the pages they saved.",
      },
    },
    required: ["page"],
  },
  async run(args, { db, openai }) {
    const reading = await currentReading(db);
    if (!reading) return { ok: false, reason: "No reading session yet. Sync the book first." };
    const page = Number(args.page);
    // Prefer a summary grounded in what they saved this session; the model's phrase is the fallback
    const saved = reading.note ? await sessionText(db, reading.note.id) : "";
    const summary = (saved && (await whereTheyStopped(openai, saved))) ||
      (typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : null);
    const { error } = await db
      .from("reading_sessions")
      .update({ ended_at: new Date().toISOString(), end_page: page, summary })
      .eq("id", reading.session.id);
    if (error) throw error;
    if (reading.note) await addToNote(db, reading.note.id, null, `Stopped on page ${page}, ${stamp()}.${summary ? ` ${summary.replace(/\.$/, "")}.` : ""}`);
    const start = reading.session.start_page;
    return { ok: true, book: reading.book.name, page, pages_read: start != null ? page - start : null };
  },
};

// The inverse of sync_book: camera on → "take the photo" → cover photo → find the book → confirm → delete it
// with its sessions and notes.

export const deleteBook: Agent = {
  name: "delete_book",
  group: "tools",
  description: "Remove a book from the reader's library. Reads the cover, finds the book and asks for confirmation; nothing is deleted yet.",
  triggers: ["voice"],
  needsImage: { countdown: 3 },
  async run(_args, { image, openai, db }) {
    const { cover, retry } = await readTitleAndAuthor("delete_book", image, openai);
    if (retry) return retry;
    const book = await findBook(db, cover.name, cover.author);
    if (!book) return { ok: false, camera: "off", reason: `"${cover.name}" isn't in the library, so there's nothing to delete.` };

    const count = async (table: string) =>
      (await db.from(table).select("id", { count: "exact", head: true }).eq("book_id", book.id)).count ?? 0;
    const [sessions, annotations] = await Promise.all([count("reading_sessions"), count("annotations")]);
    return {
      ok: true,
      status: "needs_confirmation",
      camera: "off",
      book: { id: book.id, name: book.name, author: book.author },
      reading_sessions: sessions,
      saved_quotes: annotations,
      next: `Nothing has been deleted yet. Ask the reader whether to delete "${book.name}" along with its ${sessions} reading sessions and ${annotations} saved quotes. Only if they clearly say yes, call confirm_delete_book with book_id "${book.id}".`,
    };
  },
};

export const confirmDeleteBook: Agent = {
  name: "confirm_delete_book",
  group: "tools",
  description: "Delete a book after the reader confirmed it. Only call with the book_id that delete_book returned, and only after a clear yes.",
  triggers: ["voice"],
  parameters: {
    type: "object",
    properties: { book_id: { type: "string", description: "The book_id from delete_book" } },
    required: ["book_id"],
  },
  async run(args, { db }) {
    const { data, error } = await db.from("books").delete().eq("id", String(args.book_id)).select("name");
    if (error) throw error;
    if (!data?.length) return { ok: false, reason: "That book was already gone." };
    return { ok: true, deleted: data[0].name };
  },
};
