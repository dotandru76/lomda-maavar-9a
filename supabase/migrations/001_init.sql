create table public.progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text not null,
  type text not null check (type in ('login','signup','lesson_open','step_done','step_fail','exam_done','drill')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.events (created_at);
alter table public.progress enable row level security;
alter table public.events enable row level security;
create policy "own progress read"  on public.progress for select using (auth.uid() = user_id);
create policy "own progress write" on public.progress for insert with check (auth.uid() = user_id);
create policy "own progress upd"   on public.progress for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own events insert"  on public.events   for insert with check (auth.uid() = user_id);
-- no select/delete policy on events for students: they cannot read the log

create table if not exists public.digest_log (
  id bigint generated always as identity primary key,
  kind text not null default 'digest',
  status text not null,
  detail text,
  created_at timestamptz not null default now()
);
alter table public.digest_log enable row level security;
