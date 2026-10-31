import { connection } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./server";

// Reads for the dashboard pages (server components only: they use the secret key).

// Every dashboard page reads live data. connection() keeps `next build` from prerendering them,
// which would bake in build-time rows (and needs the Supabase env at build time).
export async function dashboardDb() {
  await connection();
  return supabase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

export interface NoteSummary {
  id: string;
  path: string;
  created_at: string;
  updated_at: string;
  session: { start_page: number | null; end_page: number | null } | null;
}

export interface LibraryBook {
  id: string;
  name: string | null;
  author: string | null;
  notes_folder: string | null;
  cover_path: string | null;
  notes: NoteSummary[];
}

// A cover read can come back as the string "null" (see the books table); show those as missing
const blank = (s: string | null | undefined) => !s?.trim() || s.trim().toLowerCase() === "null";
export const bookName = (b: { name: string | null }) => (blank(b.name) ? "Untitled book" : b.name!);
export const authorName = (b: { author: string | null }) => (blank(b.author) ? null : b.author);

// Books with their notes, newest first. A book's place is its newest note; books without notes go last.
export async function library(db: SupabaseClient): Promise<LibraryBook[]> {
  const [books, notes] = await Promise.all([
    db.from("books").select("id, name, author, notes_folder, cover_path, created_at").order("created_at", { ascending: false }),
    db
      .from("notes")
      .select("id, path, created_at, updated_at, book_id, session:reading_sessions(start_page, end_page)")
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);
  if (books.error) throw books.error;
  if (notes.error) throw notes.error;
  const byBook = new Map<string, NoteSummary[]>();
  for (const n of notes.data ?? []) {
    const { book_id, session, ...rest } = n as unknown as NoteSummary & { book_id: string; session: NoteSummary["session"] | NoteSummary["session"][] };
    const list = byBook.get(book_id) ?? [];
    list.push({ ...rest, session: Array.isArray(session) ? (session[0] ?? null) : session });
    byBook.set(book_id, list);
  }
  const out = (books.data ?? []).map(({ created_at: _c, ...b }) => ({ ...b, notes: byBook.get(b.id) ?? [] }));
  const newest = (b: LibraryBook) => b.notes[0]?.created_at ?? "";
  return out.sort((a, b) => newest(b).localeCompare(newest(a))); // stable: note-less books keep created_at order
}

export interface NoteDetail {
  id: string;
  path: string;
  content: string;
  created_at: string;
  updated_at: string;
  book: { id: string; name: string | null; author: string | null; notes_folder: string | null };
  session: { started_at: string; ended_at: string | null; start_page: number | null; end_page: number | null; summary: string | null } | null;
}

export async function getNote(db: SupabaseClient, id: string): Promise<NoteDetail | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db
    .from("notes")
    .select(
      "id, path, content, created_at, updated_at, book:books(id, name, author, notes_folder), session:reading_sessions(started_at, ended_at, start_page, end_page, summary)",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const one = <T,>(v: T | T[]) => (Array.isArray(v) ? (v[0] ?? null) : v);
  const d = data as unknown as NoteDetail & { book: NoteDetail["book"] | NoteDetail["book"][]; session: NoteDetail["session"] | NoteDetail["session"][] };
  return { ...d, book: one(d.book)!, session: one(d.session) };
}

// Download links (an hour) for objects in the private captures bucket, keyed by their path
export async function signPaths(db: SupabaseClient, paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return {};
  const { data } = await db.storage.from("captures").createSignedUrls(unique, 3600);
  const out: Record<string, string> = {};
  for (const s of data ?? []) if (s.path && s.signedUrl) out[s.path] = s.signedUrl;
  return out;
}

// The same for the captures/... photos a note links to, keyed by the link as written
export async function signCaptures(db: SupabaseClient, content: string): Promise<Record<string, string>> {
  const signed = await signPaths(db, [...content.matchAll(/\]\(captures\/([^)\s]+)\)/g)].map((m) => m[1]));
  return Object.fromEntries(Object.entries(signed).map(([path, url]) => [`captures/${path}`, url]));
}

// "2026-10-30 18.40.md" in "The Chairs Are Where the People Go/..." → "2026-10-30 18.40"
export const noteName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");
