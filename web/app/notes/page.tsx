import Link from "next/link";
import { dashboardDb, library } from "@/lib/dashboard";
import { Shell } from "../_ui/shell";

export const metadata = { title: "Notes" };

export default async function NotesPage() {
  const books = await library(await dashboardDb());
  const any = books.some((b) => b.notes.length);
  return (
    <Shell books={books} open={false}>
      <h1 className="title">{any ? "Pick a note" : "No notes yet"}</h1>
      <div className="actions">
        <Link className="btn btn-filled" href="/notes/new">
          New note ›
        </Link>
      </div>
    </Shell>
  );
}
