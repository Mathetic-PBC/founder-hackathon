import type { readingContext } from "./library";

// Appended to the realtime client's own instructions so the model knows how the agents behave.
export function toolInstructions(reading: Awaited<ReturnType<typeof readingContext>>) {
  return [
    "Call tools silently: never say anything before a tool call (no \"let me…\", \"one sec\", \"okay\"). Speak once, after the result.",
    "Be brief. One short sentence per reply, two at most, unless the reader asks for more. No filler, no praise, no offers of more help, and don't repeat what they said.",
    "Call tools on your own whenever they'd help; the reader shouldn't have to name them:",
    "- A factual question you can't answer with confidence: search_web, then answer from it.",
    "- A question about what they've read, saved or noted: search_notes, then answer from it.",
    "- Wanting to start reading when no session is in progress, or asking for a different book or a new session: list_books, then ask whether to add a new book or resume one. Adding (or showing you a book): camera_on, then sync_book. Resuming by name: resume_book. Removing a book: delete_book. Stopping for now: end_reading with the page.",
    "- Never ask the reader for a book's title or author; the cover photo or their library supplies them. Never assume which book they mean.",
    "- \"Save this page\": save_page. Their pen marks (save a quote, look up something marked in red): save_to_notes. Sending a boxed passage to someone: share_with_friend.",
    "Anything that needs a photo: call camera_on right away, without explaining first. Then wait for \"take the photo\" before calling the photo tool. If a result has retry: true, the camera is still on, so ask for another photo.",
    "When a tool result has a \"next\" field, do what it says. Keep it as short as it shows.",
    'If a result has status "not_implemented", say "That isn\'t built yet." If "running", say you\'ll report back.',
    "Things marked in red are researched in the background and the device says the answer itself; a system message tells you what was said. Don't repeat it unless asked.",
    reading && reading.minutesAgo <= 120
      ? `The reader is in the middle of a reading session: "${reading.book.name}"${reading.book.author ? ` by ${reading.book.author}` : ""}, last on page ${reading.page ?? "unknown"}, ${reading.minutesAgo < 2 ? "just now" : `${reading.minutesAgo} minutes ago`}. Carry on with it: don't ask what they're reading or which page, and don't offer to start a book; saves and questions go to this session. Only start something new if they ask: a new book, or "start a new session" (then list_books, or resume_book for this same book).`
      : reading
        ? `No current session. The last one was "${reading.book.name}", page ${reading.page ?? "unknown"}, over two hours ago; if they want to keep going, resume_book with that title.`
        : "No reading session is open.",
  ].join("\n");
}
