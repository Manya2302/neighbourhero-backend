import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import { connectPostgres } from './pg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is missing. Add it to .env before pushing to Supabase.');
  process.exit(1);
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function loadStore() {
  const dataPath = path.join(__dirname, 'data', 'store.json');
  if (!fs.existsSync(dataPath)) return { issues: [], comments: [], notifications: [], users: [], events: [] };
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  data.issues ??= [];
  data.comments ??= [];
  data.notifications ??= [];
  data.users ??= [];
  data.events ??= [];
  return data;
}

const client = await connectPostgres();

const store = loadStore();

await client.query(
  `insert into public.profiles (id, name, email, area)
   values ($1, $2, $3, $4)
   on conflict (id) do update set
     name = excluded.name,
     email = excluded.email,
     area = excluded.area`,
  [
    store.profile?.id || 'local-hero',
    store.profile?.name || 'Parth Patel',
    store.profile?.email || 'talaviyaparth07@gmail.com',
    store.profile?.area || 'Ahmedabad',
  ],
);

await client.query(
  `insert into public.settings (id, language, notifications_enabled, dark_mode)
   values ($1, $2, $3, $4)
   on conflict (id) do update set
     language = excluded.language,
     notifications_enabled = excluded.notifications_enabled,
     dark_mode = excluded.dark_mode`,
  [
    'local-hero',
    store.settings?.language || 'English',
    store.settings?.notificationsEnabled !== false,
    store.settings?.darkMode !== false,
  ],
);

const staff = [
  {
    id: '11111111-1111-4111-a111-111111111111',
    name: 'Super Admin',
    email: 'admin@neighbourhero.app',
    username: 'CityAdmin',
    password: 'admin123',
    role: 'admin',
    area: 'Ahmedabad',
  },
  {
    id: '22222222-2222-4222-a222-222222222222',
    name: 'Rahul Mehta',
    email: 'worker@neighbourhero.app',
    username: 'FieldWorker',
    password: 'worker123',
    role: 'worker',
    area: 'Ahmedabad',
  },
  {
    id: '33333333-3333-4333-a333-333333333333',
    name: 'Road Crew',
    email: 'crew@neighbourhero.app',
    username: 'RoadCrew',
    password: 'crew123',
    role: 'worker',
    area: 'Ahmedabad',
  },
  {
    id: '44444444-4444-4444-a444-444444444444',
    name: 'Green Society',
    email: 'ngo@neighbourhero.app',
    username: 'GreenSociety',
    password: 'ngo123',
    role: 'ngo',
    area: 'Ahmedabad',
  },
  {
    id: '55555555-5555-4555-a555-555555555555',
    name: 'Parth Patel',
    email: 'neighbour@neighbourhero.app',
    username: 'ParthPatel',
    password: 'neighbour123',
    role: 'citizen',
    area: 'Ahmedabad',
  },
];

const users = [
  ...staff.map((item) => ({
    ...item,
    passwordHash: hashPassword(item.password),
    area: 'Ahmedabad',
    avatarId: 'hero',
    avatarUrl: null,
    googleId: null,
  })),
  ...store.users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    passwordHash: user.passwordHash,
    role: user.role || 'citizen',
    area: user.area || 'India',
    avatarId: user.avatarId || 'hero',
    avatarUrl: user.avatarUrl || null,
    googleId: user.googleId || null,
  })),
];

for (const user of users) {
  if (!user.id || !user.email) continue;
  await client.query(
    `insert into public.users (
       id, name, email, username, avatar_id, avatar_url, google_id, password_hash, area, role
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set
       name = excluded.name,
       email = excluded.email,
       username = excluded.username,
       role = excluded.role,
       password_hash = coalesce(excluded.password_hash, public.users.password_hash)`,
    [
      user.id,
      user.name,
      String(user.email).toLowerCase(),
      user.username || user.name?.replace(/\s+/g, '') || 'Hero',
      user.avatarId || 'hero',
      user.avatarUrl,
      user.googleId,
      user.passwordHash || null,
      user.area || 'India',
      user.role || 'citizen',
    ],
  );
  await client.query(
    `update public.users
     set role = $1, password_hash = coalesce($2, password_hash), name = $3, username = $4
     where lower(email) = lower($5)`,
    [user.role || 'citizen', user.passwordHash || null, user.name, user.username, user.email],
  );
}

for (const issue of store.issues) {
  await client.query(
    `insert into public.issues (
       id, title, description, category, status, priority, latitude, longitude,
       photo_url, image_url, photo_path, votes, upvotes, reporter_name, location_label,
       reporter_id, created_at, assigned_worker_id, assigned_worker_name, proof_url,
       proof_path, worker_note, approval, due_at, linked_count, duplicate_of,
       ai_category, ai_confidence, ngo_verified
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$11,$12,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
     )
     on conflict (id) do update set
       title = excluded.title,
       description = excluded.description,
       category = excluded.category,
       status = excluded.status,
       priority = excluded.priority,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       votes = excluded.votes,
       upvotes = excluded.upvotes,
       reporter_name = excluded.reporter_name,
       image_url = excluded.image_url,
       photo_url = excluded.photo_url,
       approval = excluded.approval,
       linked_count = excluded.linked_count,
       ngo_verified = excluded.ngo_verified`,
    [
      issue.id,
      issue.title,
      issue.description,
      issue.category,
      issue.status || 'pending',
      issue.priority || 'Medium',
      issue.latitude,
      issue.longitude,
      issue.photo_url || issue.photoUrl || null,
      issue.photo_path || null,
      issue.votes || 0,
      issue.reporter_name || 'Neighbour',
      issue.reporter_id || null,
      issue.created_at || new Date().toISOString(),
      issue.assigned_worker_id || null,
      issue.assigned_worker_name || null,
      issue.proof_url || null,
      issue.proof_path || null,
      issue.worker_note || '',
      issue.approval || 'none',
      issue.due_at || null,
      issue.linked_count || 1,
      issue.duplicate_of || null,
      issue.ai_category || null,
      issue.ai_confidence || null,
      Boolean(issue.ngo_verified),
    ],
  );
}

for (const comment of store.comments) {
  await client.query(
    `insert into public.comments (id, issue_id, author, body, created_at)
     values ($1,$2,$3,$4,$5)
     on conflict (id) do update set body = excluded.body, author = excluded.author`,
    [
      comment.id,
      comment.issue_id,
      comment.author,
      comment.body,
      comment.created_at || new Date().toISOString(),
    ],
  );
}

for (const note of store.notifications) {
  await client.query(
    `insert into public.notifications (
       id, title, body, icon, issue_id, read, is_read, created_at, user_id, type, coins, issue_title
     ) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$3)
     on conflict (id) do update set
       title = excluded.title,
       body = excluded.body,
       read = excluded.read,
       is_read = excluded.is_read`,
    [
      note.id,
      note.title,
      note.body,
      note.icon || 'notifications',
      note.issue_id || null,
      Boolean(note.read),
      note.created_at || new Date().toISOString(),
      note.user_id || '11111111-1111-4111-a111-111111111111',
      note.type || 'community',
      note.coins || 0,
    ],
  );
}

for (const event of store.events || []) {
  await client.query(
    `insert into public.events (id, title, description, area, starts_at, created_by, created_by_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set title = excluded.title, description = excluded.description`,
    [
      event.id,
      event.title,
      event.description || '',
      event.area || 'Local neighbourhood',
      event.startsAt || event.starts_at || new Date().toISOString(),
      event.createdBy || null,
      event.createdById || null,
      event.created_at || new Date().toISOString(),
    ],
  );
}

const counts = await client.query(`
  select
    (select count(*) from public.users) as users,
    (select count(*) from public.issues) as issues,
    (select count(*) from public.comments) as comments,
    (select count(*) from public.notifications) as notifications,
    (select count(*) from public.events) as events
`);

await client.end();

const row = counts.rows[0];
console.log(
  `Pushed NeighbourHero data to Supabase: ${row.users} users, ${row.issues} issues, ${row.comments} comments, ${row.notifications} notifications, ${row.events} events.`,
);
