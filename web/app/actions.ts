"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/server";
import { folderName, stamp } from "@/lib/library";
import { isUuid } from "@/lib/dashboard";
import { formatPhone, toE164, type FormState } from "@/lib/forms";
import { assignToLine, explainPhotonError, listAssignments, PhotonError, sameHandle } from "@/lib/photon";

// The dashboard's writes. No auth, by decision (hackathon): anyone with the URL can call these.

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

// ── Notes ────────────────────────────────────────────────────────────────────────────────

// A note needs a book: an existing one, or a new one made from name/author.
export async function createNote(_prev: FormState, form: FormData): Promise<FormState> {
  const values = {
    book: field(form, "book"),
    new_name: field(form, "new_name").trim(),
    new_author: field(form, "new_author").trim(),
    title: field(form, "title").trim(),
    content: field(form, "content"),
  };
  const db = supabase();

  let book: { id: string; name: string | null; notes_folder: string | null };
  if (values.book && values.book !== "new") {
    if (!isUuid(values.book)) return { error: "That book doesn't exist.", values };
    const { data, error } = await db.from("books").select("id, name, notes_folder").eq("id", values.book).maybeSingle();
    if (error) return { error: error.message, values };
    if (!data) return { error: "That book was deleted. Pick another or add it again.", values };
    book = data;
  } else {
    if (!values.new_name) return { error: "Give the new book a name.", values };
    // The same title typed twice is the same book
    const { data: all, error } = await db.from("books").select("id, name, notes_folder");
    if (error) return { error: error.message, values };
    const same = (all ?? []).find((b) => b.name?.trim().toLowerCase() === values.new_name.toLowerCase());
    if (same) book = same;
    else {
      const { data, error: e2 } = await db
        .from("books")
        .insert({ name: values.new_name, author: values.new_author || null, notes_folder: folderName(values.new_name) })
        .select("id, name, notes_folder")
        .single();
      if (e2) return { error: e2.message, values };
      book = data;
    }
  }

  let folder = book.notes_folder;
  if (!folder) {
    folder = folderName(book.name ?? "Untitled");
    await db.from("books").update({ notes_folder: folder }).eq("id", book.id);
  }
  const path = await freePath(db, book.id, folder, folderName(values.title || stamp()));
  const now = new Date().toISOString();
  const { data: note, error } = await db
    .from("notes")
    .insert({ book_id: book.id, reading_session_id: null, path, content: values.content, created_at: now, updated_at: now })
    .select("id")
    .single();
  if (error) return { error: error.message, values };

  revalidatePath("/", "layout");
  redirect(`/notes/${note.id}`);
}

// pi/vault.py writes notes to disk by path, so two notes in a folder can't share a name
async function freePath(db: SupabaseClient, bookId: string, folder: string, name: string) {
  const { data } = await db.from("notes").select("path").eq("book_id", bookId);
  const taken = new Set((data ?? []).map((n) => n.path.toLowerCase()));
  let path = `${folder}/${name}.md`;
  for (let i = 2; taken.has(path.toLowerCase()); i++) path = `${folder}/${name} ${i}.md`;
  return path;
}

// Bumps updated_at: the Pi mirrors notes changed since its last sync (GET /api/notes?since=)
export async function updateNote(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const content = field(form, "content");
  if (!isUuid(id)) return { error: "That note doesn't exist.", values: { content } };
  const db = supabase();
  const { data, error } = await db
    .from("notes")
    .update({ content, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { error: error.message, values: { content } };
  if (!data?.length) return { error: "That note was deleted.", values: { content } };
  revalidatePath("/", "layout");
  redirect(`/notes/${id}`);
}

// ── Contacts and the Photon line ─────────────────────────────────────────────────────────

// Saves the contact, then (unless unticked) puts their number on the team's shared iMessage line.
export async function addContact(_prev: FormState, form: FormData): Promise<FormState> {
  const values = { name: field(form, "name").trim(), phone: field(form, "phone").trim(), line: field(form, "line") };
  if (!values.name) return { error: "Add their name.", values };
  const phone = toE164(values.phone);
  if (!phone) return { error: "Use their full number, like +1 858 555 0123.", values };

  const db = supabase();
  const { data: existing, error } = await db.from("contacts").select("id, name, phone").eq("phone", phone).limit(1);
  if (error) return { error: error.message, values };
  let contact = existing?.[0];
  if (!contact) {
    const { data, error: e2 } = await db.from("contacts").insert({ name: values.name, phone }).select("id, name, phone").single();
    if (e2) return { error: e2.message, values };
    contact = data;
  }
  revalidatePath("/contacts");
  const was = existing?.[0] ? `${contact.name} was already a contact.` : `Saved ${contact.name}.`;
  if (values.line !== "on") return { message: was };
  return putOnLine(contact, was);
}

// "Add to line" on a contact who isn't on it yet (e.g. the first try failed)
export async function assignContact(contactId: string, _prev: FormState, _form: FormData): Promise<FormState> {
  if (!isUuid(contactId)) return { error: "That contact doesn't exist." };
  const { data: contact, error } = await supabase().from("contacts").select("id, name, phone").eq("id", contactId).maybeSingle();
  if (error) return { error: error.message };
  if (!contact) return { error: "That contact was deleted." };
  return putOnLine(contact, "");
}

async function putOnLine(contact: { id: string; name: string; phone: string }, was: string): Promise<FormState> {
  const [firstName, ...rest] = contact.name.split(/\s+/);
  try {
    // A fresh key per click: a retry after a failure must not replay the failure
    const a = await assignToLine({ handle: contact.phone, firstName, lastName: rest.join(" ") }, `bart-contact-${contact.id}-${randomUUID()}`);
    revalidatePath("/contacts");
    return { assigned: { name: contact.name, handle: contact.phone, line: a.assignedPhoneNumber } };
  } catch (err) {
    if (err instanceof PhotonError && err.code === "ASSIGNMENT_EXISTS") {
      const found = (await listAssignments().catch(() => [])).find((x) => sameHandle(x.handle, contact.phone));
      revalidatePath("/contacts");
      if (found) return { assigned: { name: contact.name, handle: contact.phone, line: found.assignedPhoneNumber } };
    }
    const reason = err instanceof PhotonError ? explainPhotonError(err) : `Couldn't reach Photon (${err instanceof Error ? err.message : String(err)}).`;
    const lead = was ? `${was} ` : "";
    return { error: `${lead}Couldn't add ${formatPhone(contact.phone)} to Bart's line. ${reason}` };
  }
}
