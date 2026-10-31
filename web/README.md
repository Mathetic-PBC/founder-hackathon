# web

Bart's agents, as a Next.js app on Vercel. The Pi (`pi/wake_word.py`) talks to OpenAI Realtime itself. When the model calls a tool, `pi/agents.py` posts the call here, this app runs the agent, and the result goes back into the conversation. Everything is stored in Supabase.

```
pi/wake_word.py ── wake word → sentence ──► OpenAI Realtime
      │  agents.start(): GET /api/agents → tools + instructions for session.update
      │  model calls a tool (response.done → function_call)
      │  agents.handle(): photo after a countdown if needed, then
      └─ POST /api/agents/:name ──► dispatch → agent.run ──► Supabase (agent_runs, captures/, books, …)
         ◄── { status, result } ── function_call_output + response.create → spoken follow-up
```

## Building an agent

`lib/agents/index.ts` is the one list, one entry per heading in the Agents note. The model's tools and the highlighter bindings both come from it. An entry without `run` is logged and answers `not_implemented`, and the model says so out loud. To build one, add `run(args, ctx)` and return anything JSON; the model sees it as the tool output. `ctx` has `db` (Supabase), `openai`, `image` (if it declared `needsImage`), `sessionId` and `runId`. See `lib/agents/reading.ts` and `lib/agents/quotes.ts`. A result can carry a `next` field telling the model what to say or do next, which is how multi-step flows (confirm the page, confirm a delete) work.

| field | effect |
|---|---|
| `triggers: ["voice"]` | offered to the realtime model as a tool |
| `triggers: ["highlight"]` | can be bound to a highlighter color |
| `parameters` | JSON Schema for the arguments the model fills in |
| `needsImage: { countdown: 3 }` | the Pi beeps a countdown, takes a photo and attaches it |
| `needsImage: { countdown: 0 }` | on command: Bart says it's turning on the camera, and the photo is taken when the reader says "take the photo" |
| `async: true` | answers `running` right away and runs after the response; the Pi hands over the result before the next sentence |

Built so far:

| agent | what it does |
|---|---|
| `sync_book` | cover photo → title and author → finds the book or adds it; for a known book, asks if they're still on the last page |
| `start_reading` / `end_reading` | opens and closes a reading session (start and end page, a one-line summary) with its own note |
| `delete_book` → `confirm_delete_book` | the inverse of sync: cover photo → finds the book → asks → deletes it with its sessions, notes and quotes |
| `save_to_notes` | photo on command → `gpt-6.1-terra` transcribes the text inside the reader's pen box → quote block in the session note |
| `share_with_friend` | the same transcription, saved to the note and texted to a contact by iMessage through Photon |
| `bind_highlighter` | rewrites `highlighter_bindings` |

Notes form a vault: one folder per book (`books.notes_folder`), one markdown file per reading session (`notes.path`), photos linked as `captures/...`. `pi/vault.py` mirrors it to disk.

Photon's shared iMessage line can't text anyone first, and it only reaches the number it's assigned to (Hudson's). `lib/photon.ts` replies in the conversation that number started; anyone else gets an explanation instead of a text.

## Dashboard

Pages for the team, served by this same app (same Vercel deploy, same env). **No login**, by decision: anyone with the URL can read notes, write notes and add contacts. The `/api/*` routes keep their token.

| page | |
|---|---|
| `/` | redirects to `/notes` |
| `/notes` | books → notes in the left rail (newest first) |
| `/notes/:id` | the note, rendered (headings, quote blocks, emphasis, lists, photos via signed `captures/` URLs) |
| `/notes/:id/edit` | edit the markdown; saving bumps `updated_at`, so `pi/vault.py` picks it up on its next sync |
| `/notes/new` | new note in an existing book or a new one (`?book=<id>` preselects); path is `<folder>/<name or stamp()>.md`, `reading_session_id` null |
| `/books` | every book with its cover (signed `captures/` URL), author and notes |
| `/contacts` | contacts with their Photon line status, plus an add form (name, phone) |

Reads are server components (`lib/dashboard.ts`); writes are server actions (`app/actions.ts`). The secret Supabase key never reaches the browser.

Adding a contact inserts the `contacts` row and, unless unticked, calls Photon's `POST /platforms/imessage/assignments` (`lib/photon.ts` `assignToLine`). That puts their number on the team's shared line and **uses a seat of the Photon plan** (this project: shared mode, 25 seats). A shared line can't text first: the person has to text the assigned number once before Bart can message them. After adding, the page shows that number large, plus a "Text <name> the number" button that opens Messages on your phone with the request already written to them. Line status comes from `GET` on the same path, matched by number. A contact who isn't on the line gets an "Add to line" button; Photon's errors (seats used up, key scope, validation) show as messages.

The look is Engelbart's design system: `app/tokens/` is copied unchanged from engelbart-canvas (`src/renderer/tokens`, plus `fonts.css` for Source Code Pro), and `app/globals.css` builds everything from those variables. Notes are set in Source Code Pro. Dark mode follows the OS.

`PHOTON_API_BASE` (optional) points the Photon client at another base URL; it exists only for testing against a local stub.

## Routes

All except `/api/health` need the `x-bart-token` header.

| route | |
|---|---|
| `GET /api/agents` | `{ tools, instructions, agents }`, fetched when a conversation opens |
| `POST /api/agents/:name` | JSON `{ args, session_id?, call_id?, client? }`, or multipart with the same fields plus `image` |
| `GET /api/runs/:id` | status and result of one run |
| `POST /api/highlight` | `{ color, session_id?, text? }` plus an optional `image` → runs the agent bound to that color |
| `GET /api/notes?since=` | notes changed since a time, with download links for their photos (for `pi/vault.py`) |
| `POST /api/transcripts` | `{ session_id, role, text }` |
| `GET /api/health` | `{ ok: true }` |

Try an agent without the Pi:

```bash
curl -X POST localhost:3000/api/agents/search_notes -H "x-bart-token: $BART_TOKEN" \
  -H 'content-type: application/json' -d '{"args":{"query":"chairs"}}'
```

## Run locally

```bash
cd web && npm install
cp .env.example .env.local   # BART_TOKEN is any shared string; the Pi sends the same one
npm run dev
```

The schema is in `supabase/migrations/` (0001, 0002), already applied to the `founder-hackathon` project. RLS is on with no policies, so only this server (with the secret key) can read or write.

## Deploy

Import the repo in Vercel and set **Root Directory** to `web`. Add every variable in `.env.example`: `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `BART_TOKEN`, `PHOTON_API_KEY`, `PHOTON_PROJECT_ID` and `PHOTON_AGENT_HANDLE`. Then set `BART_URL` in `pi/.env` to the `*.vercel.app` URL.
