create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id text primary key default 'local-hero',
  name text not null,
  email text not null,
  area text not null default 'Ahmedabad',
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists avatar_id text not null default 'hero';
alter table public.profiles add column if not exists avatar_url text;

create table if not exists public.settings (
  id text primary key default 'local-hero',
  language text not null default 'English',
  notifications_enabled boolean not null default true,
  dark_mode boolean not null default true
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  username text not null,
  avatar_id text not null default 'hero',
  avatar_url text,
  google_id text,
  password_hash text,
  area text not null default 'India',
  created_at timestamptz not null default now()
);

alter table public.users add column if not exists username text;
alter table public.users add column if not exists avatar_id text;
alter table public.users add column if not exists avatar_url text;
alter table public.users add column if not exists google_id text;
alter table public.users add column if not exists password_hash text;
alter table public.users add column if not exists area text;
alter table public.users add column if not exists role text;
update public.users set username = split_part(email, '@', 1) where username is null or username = '';
update public.users set avatar_id = 'hero' where avatar_id is null;
update public.users set area = 'India' where area is null;
update public.users set role = 'citizen' where role is null;

alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check
  check (role in ('citizen', 'admin', 'worker', 'ngo'));

create unique index if not exists users_email_idx on public.users (lower(email));
create unique index if not exists users_username_idx on public.users (lower(username));
create unique index if not exists users_google_id_idx on public.users (google_id)
  where google_id is not null;

create table if not exists public.sessions (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on public.sessions (user_id);

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  category text not null check (
    category in (
      'Pothole',
      'Garbage',
      'Streetlight',
      'Water leak',
      'Road damage',
      'Other'
    )
  ),
  status text not null default 'pending' check (
    status in ('pending', 'in_progress', 'resolved')
  ),
  priority text not null default 'Medium' check (
    priority in ('Low', 'Medium', 'High', 'Critical')
  ),
  latitude double precision not null,
  longitude double precision not null,
  photo_url text,
  photo_path text,
  votes integer not null default 0,
  reporter_name text not null default 'Neighbour',
  created_at timestamptz not null default now()
);

alter table public.issues add column if not exists reporter_id uuid;
alter table public.users add column if not exists role text not null default 'citizen';

alter table public.issues add column if not exists assigned_worker_id uuid;
alter table public.issues add column if not exists assigned_worker_name text;
alter table public.issues add column if not exists proof_url text;
alter table public.issues add column if not exists proof_path text;
alter table public.issues add column if not exists worker_note text;
alter table public.issues add column if not exists approval text not null default 'none';
alter table public.issues add column if not exists due_at timestamptz;
alter table public.issues add column if not exists linked_count integer not null default 1;
alter table public.issues add column if not exists duplicate_of uuid;
alter table public.issues add column if not exists ai_category text;
alter table public.issues add column if not exists ai_confidence double precision;
alter table public.issues add column if not exists ngo_verified boolean not null default false;
alter table public.issues add column if not exists photo_url text;
alter table public.issues add column if not exists photo_path text;
alter table public.issues add column if not exists votes integer not null default 0;
alter table public.issues add column if not exists reporter_name text;
alter table public.issues add column if not exists image_url text;
alter table public.issues add column if not exists upvotes integer not null default 0;
alter table public.issues add column if not exists location_label text;
alter table public.issues drop constraint if exists issues_status_check;
alter table public.issues add constraint issues_status_check
  check (status in (
    'pending',
    'assigned',
    'in_progress',
    'arrived',
    'repairing',
    'resolved',
    'reopened',
    'solved',
    'rejected'
  ));

-- Categories are app-managed; keep constraint loose so Super Admin can add types later.
alter table public.issues drop constraint if exists issues_category_check;

alter table public.issues add column if not exists location_label text;
alter table public.issues add column if not exists address text;
alter table public.issues add column if not exists arrived_at timestamptz;
alter table public.issues add column if not exists arrived_lat double precision;
alter table public.issues add column if not exists arrived_lng double precision;
alter table public.issues add column if not exists completed_at timestamptz;
alter table public.issues add column if not exists citizen_verification text not null default 'none';
alter table public.issues add column if not exists citizen_verified_at timestamptz;
alter table public.issues add column if not exists worker_lat double precision;
alter table public.issues add column if not exists worker_lng double precision;
alter table public.issues add column if not exists worker_location_at timestamptz;
alter table public.issues add column if not exists updated_at timestamptz not null default now();

alter table public.issues drop constraint if exists issues_citizen_verification_check;
alter table public.issues add constraint issues_citizen_verification_check
  check (citizen_verification in ('none', 'pending', 'confirmed', 'rejected'));

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  area text not null default 'Local neighbourhood',
  starts_at timestamptz not null default now(),
  created_by text,
  created_by_id uuid,
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;
drop policy if exists "Public can read events" on public.events;
create policy "Public can read events" on public.events for select using (true);

create index if not exists issues_assigned_worker_id_idx on public.issues (assigned_worker_id);
create index if not exists users_role_idx on public.users (role);

create index if not exists issues_created_at_idx on public.issues (created_at desc);
create index if not exists issues_location_idx on public.issues (latitude, longitude);
create index if not exists issues_reporter_id_idx on public.issues (reporter_id);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues (id) on delete cascade,
  author text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  icon text not null default 'notifications',
  issue_id uuid,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.notifications add column if not exists body text;
alter table public.notifications add column if not exists icon text;
alter table public.notifications add column if not exists read boolean not null default false;
alter table public.notifications add column if not exists is_read boolean not null default false;
alter table public.notifications add column if not exists issue_title text;
alter table public.notifications add column if not exists user_id uuid;
alter table public.notifications add column if not exists type text not null default 'community';
alter table public.notifications add column if not exists coins integer not null default 0;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'accepted', 'assigned', 'in_progress', 'resolved', 'nearby', 'upvote',
    'community', 'status', 'coins', 'report', 'vote', 'welcome', 'profile',
    'comment', 'assign', 'arrive', 'proof', 'review_approved', 'review_rejected',
    'citizen_verify', 'citizen_reject', 'rework', 'repairing'
  ));

create index if not exists notifications_user_id_idx on public.notifications (user_id, created_at desc);

alter table public.issues enable row level security;
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.comments enable row level security;
alter table public.notifications enable row level security;
alter table public.users enable row level security;
alter table public.sessions enable row level security;

drop policy if exists "Public can read issues" on public.issues;
create policy "Public can read issues" on public.issues for select using (true);
drop policy if exists "Public can read comments" on public.comments;
create policy "Public can read comments" on public.comments for select using (true);
drop policy if exists "Public can read notifications" on public.notifications;
create policy "Public can read notifications" on public.notifications for select using (true);
drop policy if exists "Public can read profile" on public.profiles;
create policy "Public can read profile" on public.profiles for select using (true);
drop policy if exists "Public can read settings" on public.settings;
create policy "Public can read settings" on public.settings for select using (true);
drop policy if exists "Public can read usernames" on public.users;
create policy "Public can read usernames" on public.users for select using (true);
