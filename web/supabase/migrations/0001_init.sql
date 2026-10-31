-- Bart: books, voice sessions, transcripts, agent runs, highlighter bindings.
-- RLS is on with no policies: only the server (secret key) can read or write.

create table books (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  author text,
  pdf_url text,
  toc jsonb,
  cover_path text
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  client text not null default 'web',
  model text,
  book_id uuid references books (id) on delete set null
);

create table transcripts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  session_id uuid not null references sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  text text not null
);
create index transcripts_session_idx on transcripts (session_id, created_at);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  session_id uuid references sessions (id) on delete set null,
  agent text not null,
  trigger text not null check (trigger in ('voice', 'highlight', 'http')),
  call_id text,
  args jsonb not null default '{}',
  image_path text,
  status text not null default 'running'
    check (status in ('running', 'done', 'error', 'not_implemented')),
  result jsonb,
  error text
);
create index agent_runs_session_idx on agent_runs (session_id, created_at);

-- Which agent each highlighter color triggers. Reprogram by updating a row.
create table highlighter_bindings (
  color text primary key,
  agent text not null,
  updated_at timestamptz not null default now()
);

insert into highlighter_bindings (color, agent) values
  ('yellow', 'save_excerpt'),
  ('green', 'save_annotation'),
  ('blue', 'track_citation'),
  ('pink', 'word_to_anki');

alter table books enable row level security;
alter table sessions enable row level security;
alter table transcripts enable row level security;
alter table agent_runs enable row level security;
alter table highlighter_bindings enable row level security;

-- Private bucket for camera captures (page photos, covers, highlights).
insert into storage.buckets (id, name, public) values ('captures', 'captures', false)
on conflict (id) do nothing;
