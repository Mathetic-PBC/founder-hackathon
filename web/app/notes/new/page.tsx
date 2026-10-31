import { bookName, dashboardDb, library } from "@/lib/dashboard";
import { NoteForm } from "../../_ui/forms";
import { Shell } from "../../_ui/shell";

export const metadata = { title: "New note" };

export default async function NewNotePage(props: PageProps<"/notes/new">) {
  const { book } = await props.searchParams;
  const books = await library(await dashboardDb());
  const options = books.map((b) => ({ id: b.id, name: bookName(b) }));
  const preset = typeof book === "string" && options.some((b) => b.id === book) ? book : undefined;
  return (
    <Shell books={books} open>
      <h1 className="title">New note</h1>
      <NoteForm books={options} defaultBook={preset} />
    </Shell>
  );
}
