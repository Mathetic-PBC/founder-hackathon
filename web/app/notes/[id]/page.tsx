import Link from "next/link";
import { notFound } from "next/navigation";
import { bookName, dashboardDb, getNote, library, noteName, signCaptures } from "@/lib/dashboard";
import { Markdown } from "../../_ui/markdown";
import { Shell } from "../../_ui/shell";

export default async function NotePage(props: PageProps<"/notes/[id]">) {
  const { id } = await props.params;
  const db = await dashboardDb();
  const [books, note] = await Promise.all([library(db), getNote(db, id)]);
  if (!note) notFound();
  const images = await signCaptures(db, note.content);

  return (
    <Shell books={books} activeId={note.id} open>
      <div className="microcap">{bookName(note.book)}</div>
      <div className="title-row">
        <h1 className="title">{noteName(note.path)}</h1>
        <Link className="btn" href={`/notes/${note.id}/edit`}>
          Edit
        </Link>
      </div>
      <hr className="rule" />
      <Markdown source={note.content} images={images} />
    </Shell>
  );
}

export async function generateMetadata(props: PageProps<"/notes/[id]">) {
  const { id } = await props.params;
  const note = await getNote(await dashboardDb(), id);
  return { title: note ? noteName(note.path) : "Note not found" };
}
