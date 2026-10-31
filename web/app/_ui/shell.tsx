import Link from "next/link";
import type { ReactNode } from "react";
import { bookName, noteName, type LibraryBook } from "@/lib/dashboard";

// Engelbart's shape: a rail of books → notes on the left, the open note in the column.
// On a phone it is one or the other: the rail on /notes, the column once a note (or a form) is open.
export function Shell({ books, activeId, open, children }: { books: LibraryBook[]; activeId?: string; open: boolean; children: ReactNode }) {
  return (
    <div className="shell" data-open={open ? "1" : undefined}>
      <Rail books={books.filter((b) => b.notes.length)} activeId={activeId} />
      <section className="column">
        <div className="column-inner" key={activeId ?? "none"}>
          {open && (
            <Link className="back" href="/notes">
              ← Notes
            </Link>
          )}
          {children}
        </div>
      </section>
    </div>
  );
}

function Rail({ books, activeId }: { books: LibraryBook[]; activeId?: string }) {
  return (
    <nav className="rail" aria-label="Notes by book">
      <div className="rail-head">
        <span className="microcap">Notes</span>
        <Link className="rail-add" href="/notes/new">
          + New note
        </Link>
      </div>
      {books.length === 0 && <p className="rail-empty">No notes yet.</p>}
      {books.map((b) => (
        <section className="rail-book" key={b.id}>
          <div className="rail-book-name">{bookName(b)}</div>
          <ul className="rail-list">
            {b.notes.map((n) => (
              <li key={n.id}>
                <Link className="rail-row" href={`/notes/${n.id}`} aria-current={n.id === activeId ? "page" : undefined}>
                  {noteName(n.path)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
