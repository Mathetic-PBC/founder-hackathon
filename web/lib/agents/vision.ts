import type OpenAI from "openai";
import type { Capture } from "./types";

// Every photo is read by an LLM looking at the image (no OCR step): covers, boxed passages and whole pages
const VISION_MODEL = process.env.VISION_MODEL ?? "gpt-6.1-terra";

async function ask<T>(openai: OpenAI, image: Capture, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const res = await openai.responses.create({
    model: VISION_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: `data:${image.mime};base64,${image.bytes.toString("base64")}`, detail: "high" },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "result", strict: true, schema } },
  });
  return JSON.parse(res.output_text) as T;
}

const nullable = (type: string, description: string) => ({ type: [type, "null"], description });

// Models sometimes answer "null" or "unknown" as a string when they can't read something
const clean = (s: string | null) => (s && !/^\s*(null|none|unknown|n\/?a|unreadable|illegible)?\s*$/i.test(s) ? s.trim() : null);

export async function readCover(openai: OpenAI, image: Capture) {
  const r = await ask<{ name: string | null; author: string | null }>(
    openai,
    image,
    "This is a photo of a book's cover or title page. Read the title and the author. Only report what you can actually read in the photo; use null for anything that isn't legible.",
    {
      type: "object",
      properties: {
        name: nullable("string", "Book title including any subtitle, or null if unreadable"),
        author: nullable("string", "Author(s), or null if unreadable"),
      },
      required: ["name", "author"],
      additionalProperties: false,
    },
  );
  return { name: clean(r.name), author: clean(r.author) };
}


// The reader's pen marks drive what happens to a page photo (see lib/agents/marks.ts):
// red = research, dark (black, blue, pencil) = save; underline = a topic, box = a quote.
export interface Mark {
  color: "red" | "dark" | "highlighter";
  shape: "underline" | "box" | "highlight" | "margin_note" | "other";
  text: string; // the printed text the mark covers, or the handwritten words
  context: string | null; // the printed sentence the mark sits in
  note: string | null; // a handwritten comment attached to the mark
}

// Any photo except a book cover: the marks, and with fullText, every word on the page
export async function readMarks(openai: OpenAI, image: Capture, { fullText = false } = {}) {
  const r = await ask<{ page: number | null; text: string | null; marks: Mark[] }>(
    openai,
    image,
    [
      "This is a photo of a book page the reader marked by hand.",
      fullText
        ? "Transcribe all of the printed text exactly, in reading order, with a blank line between paragraphs; leave running headers and the page number out of the text."
        : "Set text to null.",
      "List every mark the reader made. For each: its color (red for red or pink ink; dark for black, blue or pencil; highlighter for translucent highlighter of any color), its shape (underline; box for a box or circle drawn around text; highlight; margin_note for handwritten words; other), the exact printed text it covers (for a margin note, the handwriting as written), the printed sentence it sits in, and any handwritten comment attached to it.",
      "Finally, the page number: the small number printed in a top or bottom corner or centered in the top or bottom margin. Not a chapter or section number, and not a number inside the text. If the open book shows two pages, give the number of the page the marks are on. If no page number is printed in the photo (for example the margin is cut off), use null; never guess.",
    ].join(" "),
    {
      type: "object",
      properties: {
        page: nullable("integer", "The printed page number from the page's corner or margin, or null if it isn't in the photo"),
        text: nullable("string", "All printed text on the page, exactly; null if not asked for or not legible"),
        marks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              color: { type: "string", enum: ["red", "dark", "highlighter"] },
              shape: { type: "string", enum: ["underline", "box", "highlight", "margin_note", "other"] },
              text: { type: "string", description: "Exact printed text the mark covers, or the handwriting for a margin note" },
              context: nullable("string", "The printed sentence the mark sits in"),
              note: nullable("string", "Handwritten comment attached to this mark, if any"),
            },
            required: ["color", "shape", "text", "context", "note"],
            additionalProperties: false,
          },
        },
      },
      required: ["page", "text", "marks"],
      additionalProperties: false,
    },
  );
  // A margin note that's already attached to a marked passage (as its note) isn't listed twice
  const attached = new Set(r.marks.map((m) => m.note?.trim().toLowerCase()).filter(Boolean));
  const marks = r.marks.filter((m) => clean(m.text) && !(m.shape === "margin_note" && attached.has(m.text.trim().toLowerCase())));
  return { page: r.page, text: fullText ? clean(r.text) : null, marks };
}
