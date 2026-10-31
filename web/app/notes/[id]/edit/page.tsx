import { notFound } from "next/navigation";
import { updateNote } from "@/app/actions";
import { bookName, dashboardDb, getNote, library, noteName } from "@/lib/dashboard";
import { EditNoteForm } from "../../../_ui/forms";
import { Shell } from "../../../_ui/shell";

export const metadata = { title: "Edit note" };

export default async function EditNotePage(props: PageProps<"/notes/[id]/edit">) {
  const { id } = await props.params;
  const db = await dashboardDb();
  const [books, note] = await Promise.all([library(db), getNote(db, id)]);
  if (!note) notFound();
  return (
    <Shell books={books} activeId={note.id} open>
      <div className="microcap">{bookName(note.book)}</div>
      <h1 className="title">{noteName(note.path)}</h1>
      <EditNoteForm action={updateNote.bind(null, note.id)} content={note.content} cancelHref={`/notes/${note.id}`} />
    </Shell>
  );
}
