import type { Agent } from "./types";
import { confirmDeleteBook, deleteBook, endReading, listBooks, resumeBook, startReading, syncBook } from "./reading";
import { savePage, saveToNotes, shareWithFriend } from "./quotes";
import { searchNotes, searchWeb } from "./search";
import { research } from "./marks";

// The single list of agents, one entry per heading in the Agents note.
// The realtime session's tools, the dispatcher and the highlighter bindings
// are all derived from this list. To build an agent, give it a `run`.

const text = (description: string) => ({ type: "string", description });

const highlight: Agent[] = [
  {
    name: "track_citation",
    group: "highlight",
    description: "Track a citation the reader highlighted: identify the referenced work and add it to their reading list.",
    triggers: ["highlight"],
    parameters: { type: "object", properties: { text: text("The highlighted citation text, if already read off the page") } },
  },
  {
    name: "word_to_anki",
    group: "highlight",
    description: "Make an Anki flashcard for a new word the reader highlighted, with its definition and the sentence it appeared in.",
    triggers: ["highlight"],
    parameters: { type: "object", properties: { text: text("The highlighted word") } },
  },
  {
    name: "save_annotation",
    group: "highlight",
    description: "Save the reader's annotation together with the surrounding text it refers to.",
    triggers: ["highlight"],
    parameters: { type: "object", properties: { text: text("The annotation") } },
  },
  {
    name: "save_excerpt",
    group: "highlight",
    description: "Save the highlighted passage as an excerpt from the current book.",
    triggers: ["highlight"],
    parameters: { type: "object", properties: { text: text("The highlighted passage") } },
  },
];

const voice: Agent[] = [
  // "Ask a question" is the realtime model itself, which calls search_web / search_notes as needed.
  // "Retrieve notes" is search_notes; "Upload text" is save_page.
  savePage,
];

// The Pi turns its camera on and keeps it on; the photo tools below then wait for "take the photo".
// It stays on until a photo tool's result says camera: "off" (or the conversation ends).
const cameraOn: Agent = {
  name: "camera_on",
  group: "tools",
  description: "Turn on the device camera. Call it immediately, before saying anything, whenever the reader wants something that needs a photo: syncing or deleting a book, saving a page, acting on pen marks, sharing a passage.",
  triggers: ["voice"],
  async run() {
    return { ok: true, next: 'Reply only: "Camera\'s on. Say \'take the photo\' when you\'re ready."' };
  },
};

const tools: Agent[] = [
  cameraOn,
  listBooks,
  resumeBook,
  syncBook,
  startReading,
  endReading,
  deleteBook,
  confirmDeleteBook,
  saveToNotes,
  shareWithFriend,
  searchNotes,
  searchWeb,
  {
    name: "deep_research",
    group: "tools",
    description: "Start a multi-minute research report on a question. Runs in the background; the result arrives later.",
    triggers: ["voice"],
    async: true,
    parameters: { type: "object", properties: { question: text("The research question") }, required: ["question"] },
  },
];

const highlightable = () => agents.filter((a) => a.triggers.includes("highlight")).map((a) => a.name);

const bindHighlighter: Agent = {
  name: "bind_highlighter",
  group: "tools",
  description:
    "Reprogram a highlighter color, e.g. 'make pink save new words to Anki'. Changes which agent runs when that color is highlighted.",
  triggers: ["voice"],
  get parameters() {
    return {
      type: "object",
      properties: {
        color: text("Highlighter color, lowercase, e.g. yellow"),
        agent: { type: "string", enum: highlightable() },
      },
      required: ["color", "agent"],
    };
  },
  async run(args, { db }) {
    const color = String(args.color).toLowerCase().trim();
    const agent = String(args.agent);
    if (!highlightable().includes(agent)) return { ok: false, reason: `${agent} can't be bound to a highlighter` };
    const { error } = await db
      .from("highlighter_bindings")
      .upsert({ color, agent, updated_at: new Date().toISOString() });
    if (error) throw error;
    return { ok: true, color, agent };
  },
};

export const agents: Agent[] = [...highlight, ...voice, ...tools, bindHighlighter, research];

export function getAgent(name: string): Agent | undefined {
  return agents.find((a) => a.name === name);
}

// What clients need to know: which tools need a photo first, which run in the background.
export function manifest() {
  return agents.map(({ name, group, description, triggers, needsImage, async, run }) => ({
    name,
    group,
    description,
    triggers,
    needsImage: needsImage ?? null,
    async: !!async,
    built: !!run,
  }));
}

export function realtimeTools() {
  return agents
    .filter((a) => a.triggers.includes("voice"))
    .map((a) => ({
      type: "function" as const,
      name: a.name,
      description: a.needsImage
        ? `${a.description} Needs a photo: call camera_on first if the camera isn't on yet, then call this only after the reader says "take the photo" (or similar). ${
            a.needsImage.countdown > 0 ? `The device counts down ${a.needsImage.countdown} seconds, then takes it.` : "The photo is taken the moment you call."
          } Don't speak before calling it. If the result has retry: true, the camera is still on: ask for another photo and call this again when they say "take the photo".`
        : a.description,
      parameters: a.parameters ?? { type: "object", properties: {} },
    }));
}
