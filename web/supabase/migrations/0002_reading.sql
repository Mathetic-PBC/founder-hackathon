-- Reading sessions, their notes, quotes/annotations, contacts and a log of sent messages.
-- Messages go out through Photon (iMessage); pi/vault.py mirrors notes into a folder per book.

alter table books add column notes_folder text;    -- this book's folder in the notes vault
alter table books add column last_synced_at timestamptz;

-- One row per sitting with a book: where it started and stopped (the reading log)
create table reading_sessions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books (id) on delete cascade,
  started_at timestamptz not null default now(),
  start_page integer,
  ended_at timestamptz,
  end_page integer,
  summary text
);
create index reading_sessions_book_idx on reading_sessions (book_id, started_at desc);

-- One markdown note per reading session, at <notes_folder>/<session start>.md in the vault
create table notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  book_id uuid not null references books (id) on delete cascade,
  reading_session_id uuid unique references reading_sessions (id) on delete cascade,
  path text not null,
  content text not null default ''
);
create index notes_updated_idx on notes (updated_at);

create table annotations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  book_id uuid references books (id) on delete cascade,
  reading_session_id uuid references reading_sessions (id) on delete set null,
  kind text not null check (kind in ('quote', 'annotation', 'excerpt', 'citation', 'word')),
  page integer,
  text text,
  image_path text,
  agent_run_id uuid references agent_runs (id) on delete set null
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null
);
-- Contacts are added from the dashboard (/contacts). The shared Photon line can only text numbers assigned
-- to it that have texted it first, so seed only your own: insert into contacts (name, phone) values ('You', '+1...');

create table messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  contact_id uuid references contacts (id) on delete set null,
  to_name text,
  to_phone text not null,
  body text not null,
  status text not null check (status in ('sent', 'error')),
  provider_message_id text,
  error text,
  agent_run_id uuid references agent_runs (id) on delete set null
);

alter table reading_sessions enable row level security;
alter table notes enable row level security;
alter table annotations enable row level security;
alter table contacts enable row level security;
alter table messages enable row level security;

-- The existing test book gets its vault folder
update books set notes_folder = regexp_replace(name, '[/\\:*?"<>|]', '', 'g') where notes_folder is null;
