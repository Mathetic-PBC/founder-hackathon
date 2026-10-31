"use client";

import Link from "next/link";
import { useActionState } from "react";
import { addContact, createNote } from "@/app/actions";
import { formatPhone, type FormState } from "@/lib/forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
const none: FormState = {};

function Alert({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p className="alert" role="alert">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="notice" role="status">
        {state.message}
      </p>
    );
  }
  return null;
}

// ── Notes ────────────────────────────────────────────────────────────────────────────────

export function NoteForm({ books, defaultBook }: { books: { id: string; name: string }[]; defaultBook?: string }) {
  const [state, action, pending] = useActionState(createNote, none);
  const v = state.values ?? {};
  // key: React resets an action form after it runs; remounting with the returned values refills it on an error
  return (
    <form action={action} className="form" key={JSON.stringify(v)}>
      <div className="form-row">
        <label className="label" htmlFor="book">
          Book
        </label>
        <div className="field select">
          <select id="book" name="book" defaultValue={v.book ?? defaultBook ?? books[0]?.id ?? "new"}>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value="new">New book…</option>
          </select>
        </div>
      </div>
      {/* shown only while "New book…" is picked (CSS :has, so it works before hydration) */}
      <div className="newbook">
        <div className="field">
          <input name="new_name" aria-label="Book title" defaultValue={v.new_name} placeholder="Title" autoComplete="off" />
        </div>
        <div className="field">
          <input name="new_author" aria-label="Author" defaultValue={v.new_author} placeholder="Author" autoComplete="off" />
        </div>
      </div>
      <div className="form-row">
        <label className="label" htmlFor="title">
          Name
        </label>
        <div className="field">
          <input id="title" name="title" defaultValue={v.title} placeholder="today’s date" autoComplete="off" />
        </div>
      </div>
      <div className="form-row">
        <label className="label" htmlFor="content">
          Note
        </label>
        <div className="field field-note">
          <textarea id="content" name="content" defaultValue={v.content} rows={16} spellCheck />
        </div>
      </div>
      <Alert state={state} />
      <div className="actions">
        <button className="btn btn-filled" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <Link className="btn" href="/notes">
          Cancel
        </Link>
      </div>
    </form>
  );
}

export function EditNoteForm({ action: save, content, cancelHref }: { action: Action; content: string; cancelHref: string }) {
  const [state, action, pending] = useActionState(save, none);
  const value = state.values?.content ?? content;
  return (
    <form action={action} className="form" key={value}>
      <div className="field field-note">
        <textarea name="content" aria-label="Note" defaultValue={value} rows={22} spellCheck autoFocus />
      </div>
      <Alert state={state} />
      <div className="actions">
        <button className="btn btn-filled" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <Link className="btn" href={cancelHref}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

// ── Contacts ─────────────────────────────────────────────────────────────────────────────

// A shared line can't text first, so the person has to text the number they were given once. The number is
// shown large, and "Text <name>" opens Messages on this phone with that request already written to them.
function Assigned({ a }: { a: NonNullable<FormState["assigned"]> }) {
  const first = a.name.split(/\s+/)[0];
  const invite = `Hi ${first}, text ${formatPhone(a.line)} once so Bart can message you.`;
  return (
    <div className="notice assigned" role="status">
      <span className="microcap">{first} texts this number first</span>
      <a className="line-number" href={`sms:${a.line}`}>
        {formatPhone(a.line)}
      </a>
      <a className="btn" href={`sms:${a.handle}?&body=${encodeURIComponent(invite)}`}>
        Text {first} the number ›
      </a>
    </div>
  );
}

export function ContactForm() {
  const [state, action, pending] = useActionState(addContact, none);
  const v = state.values ?? {};
  return (
    <>
      <form action={action} className="form" key={JSON.stringify(v)}>
        <div className="form-row">
          <label className="label" htmlFor="name">
            Name
          </label>
          <div className="field">
            <input id="name" name="name" defaultValue={v.name} autoComplete="off" required />
          </div>
        </div>
        <div className="form-row">
          <label className="label" htmlFor="phone">
            Phone
          </label>
          <div className="field">
            <input id="phone" name="phone" type="tel" inputMode="tel" defaultValue={v.phone} placeholder="+1 858 555 0123" autoComplete="off" required />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" name="line" defaultChecked={v.line == null ? true : v.line === "on"} />
          Add to Bart’s iMessage line
        </label>
        <div className="actions">
          <button className="btn btn-filled" disabled={pending}>
            {pending ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
      {state.assigned && <Assigned a={state.assigned} />}
      <Alert state={state} />
    </>
  );
}

// A contact's line state: "On line", or "Add to line" (the server action comes bound to the contact).
// Rendered for every row, so it stays mounted when the page refreshes after adding and the number stays shown.
export function LineStatus({ action: assign, onLine, line }: { action: Action; onLine: boolean; line?: string }) {
  const [state, action, pending] = useActionState(assign, none);
  return (
    <>
      {onLine && !state.assigned && (
        <span className="row-status" title={line ? `Bart texts them from ${formatPhone(line)}` : undefined}>
          On line
        </span>
      )}
      {!onLine && !state.assigned && (
        <form action={action} className="row-act">
          <button className="btn btn-sm" disabled={pending}>
            {pending ? "Adding…" : "Add to line"}
          </button>
        </form>
      )}
      {(state.assigned || state.error) && (
        <div className="row-wide">
          {state.assigned && <Assigned a={state.assigned} />}
          <Alert state={state} />
        </div>
      )}
    </>
  );
}
