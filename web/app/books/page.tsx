import Link from "next/link";
import { authorName, bookName, dashboardDb, library, noteName, signPaths } from "@/lib/dashboard";

export const metadata = { title: "Books" };

// Every book Bart knows (synced from a cover photo, or added with a note), with its cover and notes
export default async function BooksPage() {
  const db = await dashboardDb();
  const books = await library(db);
  const covers = await signPaths(db, books.map((b) => b.cover_path ?? ""));

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="title">Books</h1>
        {books.length === 0 ? (
          <p className="empty-text">No books yet.</p>
        ) : (
          <ul className="books">
            {books.map((b) => {
              const cover = b.cover_path ? covers[b.cover_path] : undefined;
              return (
                <li className="book" key={b.id}>
                  <div className="cover">
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL
                      <img src={cover} alt="" loading="lazy" />
                    ) : (
                      <span aria-hidden>{bookName(b).charAt(0)}</span>
                    )}
                  </div>
                  <div className="book-main">
                    <div className="book-name">{bookName(b)}</div>
                    {authorName(b) && <div className="book-author">{authorName(b)}</div>}
                    <ul className="book-notes">
                      {b.notes.map((n) => (
                        <li key={n.id}>
                          <Link href={`/notes/${n.id}`}>{noteName(n.path)}</Link>
                        </li>
                      ))}
                      <li>
                        <Link className="book-add" href={`/notes/new?book=${b.id}`}>
                          + New note
                        </Link>
                      </li>
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
