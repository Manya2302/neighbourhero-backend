import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { getPool } from './pg.mjs';

let pool;

function now() {
  return new Date().toISOString();
}

function iso(value) {
  if (!value) return value;
  return value instanceof Date ? value.toISOString() : value;
}

async function query(text, params = []) {
  return pool.query(text, params);
}

const SLA_HOURS = { Critical: 8, High: 24, Medium: 48, Low: 72 };
const PRIORITY_RANK = { Low: 0, Medium: 1, High: 2, Critical: 3 };

function haversineKm(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function slaHoursFor(priority) {
  return SLA_HOURS[priority] || 48;
}

function dueAtFor(row) {
  if (row.due_at) return iso(row.due_at);
  const created = new Date(row.created_at || Date.now()).getTime();
  return new Date(created + slaHoursFor(row.priority) * 60 * 60 * 1000).toISOString();
}

function applyCrowdPriority(row) {
  const votes = row.votes || 0;
  let next = row.priority || 'Medium';
  if (votes >= 25) next = 'Critical';
  else if (votes >= 12) next = 'High';
  else if (votes >= 5) next = 'Medium';
  if (PRIORITY_RANK[next] > PRIORITY_RANK[row.priority || 'Low']) {
    row.priority = next;
    const created = new Date(row.created_at || Date.now()).getTime();
    row.due_at = new Date(created + slaHoursFor(next) * 60 * 60 * 1000).toISOString();
  }
  return row;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    avatarId: row.avatar_id || 'hero',
    avatarUrl: row.avatar_url || null,
    googleId: row.google_id || null,
    passwordHash: row.password_hash || null,
    area: row.area || 'India',
    role: row.role || 'citizen',
    created_at: iso(row.created_at),
  };
}

function mapIssueRow(row) {
  return {
    ...row,
    votes: Number(row.votes ?? row.upvotes ?? 0),
    photo_url: row.photo_url || row.image_url || null,
    created_at: iso(row.created_at),
    due_at: row.due_at ? iso(row.due_at) : null,
  };
}

const ACTIVE_WORK = new Set(['in_progress', 'arrived', 'repairing']);

function isOpenIssue(status) {
  return status !== 'resolved';
}

function mapIssue(row) {
  const data = mapIssueRow(row);
  const dueAt = dueAtFor(data);
  const open = isOpenIssue(data.status);
  return {
    id: data.id,
    title: data.title,
    description: data.description,
    category: data.category,
    status: data.status === 'solved' ? 'resolved' : data.status,
    priority: data.priority,
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
    address: data.address || data.location_label || null,
    votes: data.votes,
    createdAt: data.created_at,
    updatedAt: data.updated_at ? iso(data.updated_at) : data.created_at,
    imageUri: data.photo_url,
    reporterId: data.reporter_id || null,
    reporterName: data.reporter_name,
    assignedWorkerId: data.assigned_worker_id || null,
    assignedWorkerName: data.assigned_worker_name || null,
    proofUri: data.proof_url || undefined,
    workerNote: data.worker_note || '',
    approval: data.approval || 'none',
    dueAt,
    slaHours: slaHoursFor(data.priority),
    slaBreached: open && new Date(dueAt).getTime() < Date.now(),
    linkedCount: Math.max(1, data.linked_count || 1),
    duplicateOf: data.duplicate_of || null,
    aiCategory: data.ai_category || null,
    aiConfidence: data.ai_confidence || null,
    ngoVerified: Boolean(data.ngo_verified),
    citizenVerification: data.citizen_verification || 'none',
    citizenVerifiedAt: data.citizen_verified_at ? iso(data.citizen_verified_at) : null,
    arrivedAt: data.arrived_at ? iso(data.arrived_at) : null,
    completedAt: data.completed_at ? iso(data.completed_at) : null,
    workerLat: data.worker_lat != null ? Number(data.worker_lat) : null,
    workerLng: data.worker_lng != null ? Number(data.worker_lng) : null,
  };
}

function mapNote(item) {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    icon: item.icon,
    issueId: item.issue_id,
    read: Boolean(item.read || item.is_read),
    createdAt: iso(item.created_at),
    type: item.type || 'community',
    coins: item.coins || 0,
  };
}

async function getIssueRow(id) {
  const result = await query('select * from public.issues where id = $1', [id]);
  return result.rows[0] ? mapIssueRow(result.rows[0]) : null;
}

async function saveIssueRow(row) {
  row.updated_at = now();
  await query(
    `update public.issues set
       title = $2, description = $3, category = $4, status = $5, priority = $6,
       latitude = $7, longitude = $8, photo_url = $9, image_url = $9, photo_path = $10,
       votes = $11, upvotes = $11, reporter_name = $12, reporter_id = $13,
       assigned_worker_id = $14, assigned_worker_name = $15, proof_url = $16,
       proof_path = $17, worker_note = $18, approval = $19, due_at = $20,
       linked_count = $21, duplicate_of = $22, ai_category = $23, ai_confidence = $24,
       ngo_verified = $25, address = $26, location_label = $26, arrived_at = $27,
       arrived_lat = $28, arrived_lng = $29, completed_at = $30,
       citizen_verification = $31, citizen_verified_at = $32,
       worker_lat = $33, worker_lng = $34, worker_location_at = $35, updated_at = $36
     where id = $1`,
    [
      row.id,
      row.title,
      row.description,
      row.category,
      row.status,
      row.priority,
      row.latitude,
      row.longitude,
      row.photo_url || null,
      row.photo_path || null,
      row.votes || 0,
      row.reporter_name,
      row.reporter_id || null,
      row.assigned_worker_id || null,
      row.assigned_worker_name || null,
      row.proof_url || null,
      row.proof_path || null,
      row.worker_note || '',
      row.approval || 'none',
      row.due_at || null,
      row.linked_count || 1,
      row.duplicate_of || null,
      row.ai_category || null,
      row.ai_confidence || null,
      Boolean(row.ngo_verified),
      row.address || row.location_label || null,
      row.arrived_at || null,
      row.arrived_lat ?? null,
      row.arrived_lng ?? null,
      row.completed_at || null,
      row.citizen_verification || 'none',
      row.citizen_verified_at || null,
      row.worker_lat ?? null,
      row.worker_lng ?? null,
      row.worker_location_at || null,
      row.updated_at,
    ],
  );
}

async function workerHasActiveJob(workerId, exceptIssueId) {
  const result = await query(
    `select id from public.issues
     where assigned_worker_id = $1
       and status = any($2::text[])
       and ($3::uuid is null or id <> $3)
     limit 1`,
    [workerId, [...ACTIVE_WORK], exceptIssueId || null],
  );
  return result.rows[0] || null;
}

export async function persistStore() {}

export async function pushNotification(input) {
  if (!input.userId) return null;
  const row = {
    id: randomUUID(),
    title: input.title,
    body: input.body,
    icon: input.icon || 'flag',
    issue_id: input.issueId || null,
    user_id: input.userId,
    type: input.type || 'community',
    coins: input.coins || 0,
    read: false,
    created_at: now(),
  };
  await query(
    `insert into public.notifications (
       id, title, body, icon, issue_id, read, is_read, created_at, user_id, type, coins, issue_title
     ) values ($1,$2,$3,$4,$5,false,false,$6,$7,$8,$9,$3)`,
    [
      row.id,
      row.title,
      row.body,
      row.icon,
      row.issue_id,
      row.created_at,
      row.user_id,
      row.type,
      row.coins,
    ],
  );
  return mapNote(row);
}

export async function listIssues() {
  const result = await query('select * from public.issues order by created_at desc');
  return result.rows.map((row) => mapIssue(mapIssueRow(row)));
}

export async function getIssue(id) {
  const row = await getIssueRow(id);
  return row ? mapIssue(row) : null;
}

export async function findNearbyDuplicates(input) {
  const origin = { latitude: Number(input.latitude), longitude: Number(input.longitude) };
  const maxKm = Number(input.radiusKm) > 0 ? Number(input.radiusKm) : 0.08;
  const result = await query(
    `select * from public.issues where status <> 'resolved' and duplicate_of is null`,
  );
  return result.rows
    .map(mapIssueRow)
    .filter((item) => !input.category || item.category === input.category)
    .map((item) => ({
      issue: mapIssue(item),
      km: haversineKm(origin, {
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
      }),
    }))
    .filter((item) => item.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, 5);
}

export async function mergeIntoIssue(issueId, user, extra = {}) {
  const row = await getIssueRow(issueId);
  if (!row || row.status === 'resolved') return null;
  row.votes = (row.votes || 0) + 1;
  row.linked_count = (row.linked_count || 1) + 1;
  applyCrowdPriority(row);
  if (extra.photoUrl && !row.photo_url) row.photo_url = extra.photoUrl;
  await saveIssueRow(row);
  const note = await pushNotification({
    userId: user?.id,
    title: 'Joined an existing report',
    body: `+10 coins · “${row.title}” already had a live pin. Your vote was added.`,
    icon: 'people',
    issueId: row.id,
    type: 'report',
    coins: 10,
  });
  if (row.reporter_id && row.reporter_id !== user?.id) {
    await pushNotification({
      userId: row.reporter_id,
      title: 'Neighbour confirmed your report',
      body: `A nearby photo was merged into “${row.title}”. Priority may rise with votes.`,
      icon: 'people',
      issueId: row.id,
      type: 'vote',
      coins: 2,
    });
  }
  return { issue: mapIssue(row), coins: 10, duplicate: true, notification: note };
}

export async function createIssueRecord(input) {
  if (input.mergeInto) {
    const merged = await mergeIntoIssue(input.mergeInto, { id: input.reporterId }, input);
    if (merged) return merged;
  }
  if (input.autoMerge) {
    const nearby = (
      await findNearbyDuplicates({
        latitude: input.latitude,
        longitude: input.longitude,
        category: input.category,
      })
    )[0];
    if (nearby) {
      return mergeIntoIssue(nearby.issue.id, { id: input.reporterId }, input);
    }
  }
  const createdAt = now();
  const reporter = input.reporterId ? await getUserById(input.reporterId) : null;
  const row = {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    category: input.category,
    status: 'pending',
    priority: input.priority,
    latitude: input.latitude,
    longitude: input.longitude,
    address: input.address || input.locationLabel || null,
    location_label: input.address || input.locationLabel || null,
    photo_url: input.photoUrl,
    photo_path: input.photoPath,
    votes: 0,
    reporter_name: input.reporterName || reporter?.name || 'Neighbour',
    reporter_id: input.reporterId || null,
    assigned_worker_id: null,
    assigned_worker_name: null,
    proof_url: null,
    proof_path: null,
    worker_note: '',
    approval: 'none',
    linked_count: 1,
    ai_category: input.aiCategory || null,
    ai_confidence: input.aiConfidence || null,
    ngo_verified: false,
    citizen_verification: 'none',
    due_at: new Date(Date.now() + slaHoursFor(input.priority) * 60 * 60 * 1000).toISOString(),
    created_at: createdAt,
    updated_at: createdAt,
  };
  await query(
    `insert into public.issues (
       id, title, description, category, status, priority, latitude, longitude,
       photo_url, image_url, photo_path, votes, upvotes, reporter_name, reporter_id,
       assigned_worker_id, assigned_worker_name, proof_url, proof_path, worker_note,
       approval, due_at, linked_count, ai_category, ai_confidence, ngo_verified,
       address, location_label, citizen_verification, created_at, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,0,0,$11,$12,null,null,null,null,'',
       'none',$13,1,$14,$15,false,$16,$16,'none',$17,$17
     )`,
    [
      row.id,
      row.title,
      row.description,
      row.category,
      row.status,
      row.priority,
      row.latitude,
      row.longitude,
      row.photo_url || null,
      row.photo_path || null,
      row.reporter_name,
      row.reporter_id,
      row.due_at,
      row.ai_category,
      row.ai_confidence,
      row.address,
      row.created_at,
    ],
  );
  const note = await pushNotification({
    userId: input.reporterId,
    title: 'Report added',
    body: `+30 coins · “${row.title}” is live on the map.`,
    icon: 'flag',
    issueId: row.id,
    type: 'report',
    coins: 30,
  });
  return { issue: mapIssue(row), coins: 30, duplicate: false, notification: note };
}

export async function voteIssue(id, voter) {
  const row = await getIssueRow(id);
  if (!row) return null;
  row.votes += 1;
  applyCrowdPriority(row);
  await saveIssueRow(row);
  let coins = 0;
  if (voter) {
    coins = 2;
    await pushNotification({
      userId: voter.id,
      title: 'You supported a report',
      body: `+${coins} coins for backing “${row.title}”.`,
      icon: 'trophy',
      issueId: row.id,
      type: 'coins',
      coins,
    });
    if (row.reporter_id && row.reporter_id !== voter.id) {
      await pushNotification({
        userId: row.reporter_id,
        title: 'Neighbour supported your report',
        body: `Someone voted for “${row.title}”. You earned +2 coins.`,
        icon: 'people',
        issueId: row.id,
        type: 'vote',
        coins: 2,
      });
    }
  }
  return { issue: mapIssue(row), coins };
}

export async function setIssueStatus(id, status) {
  const row = await getIssueRow(id);
  if (!row) return null;
  row.status = status;
  await saveIssueRow(row);
  let coins = 0;
  if (status === 'resolved') {
    coins = 20;
    await pushNotification({
      userId: row.reporter_id,
      title: 'Report resolved',
      body: `+${coins} coins · “${row.title}” is marked resolved.`,
      icon: 'checkmark-circle',
      issueId: row.id,
      type: 'resolved',
      coins,
    });
  } else {
    await pushNotification({
      userId: row.reporter_id,
      title: 'Report update',
      body: `“${row.title}” is now ${status.replace('_', ' ')}.`,
      icon: 'flag',
      issueId: row.id,
      type: 'status',
      coins: 0,
    });
  }
  return { issue: mapIssue(row), coins };
}

export async function listComments(issueId) {
  const result = await query(
    'select * from public.comments where issue_id = $1 order by created_at asc',
    [issueId],
  );
  return result.rows.map((item) => ({
    id: item.id,
    issueId: item.issue_id,
    author: item.author,
    body: item.body,
    createdAt: iso(item.created_at),
  }));
}

export async function addComment(issueId, body, author, userId) {
  const issue = await getIssueRow(issueId);
  if (!issue) return null;
  const row = {
    id: randomUUID(),
    issue_id: issueId,
    author: author || 'Neighbour',
    body,
    created_at: now(),
  };
  await query(
    'insert into public.comments (id, issue_id, author, body, created_at) values ($1,$2,$3,$4,$5)',
    [row.id, row.issue_id, row.author, row.body, row.created_at],
  );
  if (issue.reporter_id && issue.reporter_id !== userId) {
    await pushNotification({
      userId: issue.reporter_id,
      title: 'New comment on your report',
      body: `${row.author} commented on “${issue.title}”.`,
      icon: 'people',
      issueId: issue.id,
      type: 'comment',
      coins: 0,
    });
  }
  return {
    id: row.id,
    issueId: row.issue_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  };
}

async function noteRows(user) {
  const result = user
    ? await query(
        `select * from public.notifications
         where user_id is null or user_id = $1
         order by created_at desc`,
        [user.id],
      )
    : await query(
        `select * from public.notifications where user_id is null order by created_at desc`,
      );
  return result.rows;
}

export async function listNotifications(user) {
  return (await noteRows(user)).map(mapNote);
}

export async function markNotificationsRead(user) {
  if (user) {
    await query(
      `update public.notifications
       set read = true, is_read = true
       where user_id is null or user_id = $1`,
      [user.id],
    );
  } else {
    await query(
      `update public.notifications set read = true, is_read = true where user_id is null`,
    );
  }
  return listNotifications(user);
}

export async function listLive(user, since) {
  const notes = await listNotifications(user);
  const fresh = since ? notes.filter((item) => item.createdAt > since) : [];
  return {
    unread: notes.filter((item) => !item.read).length,
    notifications: fresh,
    latest: notes[0]?.createdAt || null,
  };
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 64);
  const previous = Buffer.from(hash, 'hex');
  return next.length === previous.length && timingSafeEqual(next, previous);
}

async function getUserById(id) {
  if (!id) return null;
  const result = await query('select * from public.users where id = $1', [id]);
  return mapUser(result.rows[0]);
}

async function allUsers() {
  const result = await query('select * from public.users');
  return result.rows.map(mapUser);
}

async function allIssues() {
  const result = await query('select * from public.issues');
  return result.rows.map(mapIssueRow);
}

function badgeFor(input) {
  if (input.role === 'ngo') return 'Community Organizer';
  if (input.role === 'admin') return 'Super Admin';
  if (input.role === 'worker') return 'Field Crew';
  if (input.points >= 400 || input.reports >= 10) return 'Civic Champion';
  if (input.reports >= 5) return 'Street Guardian';
  if (input.points >= 150) return 'Community Helper';
  if (input.reports >= 1) return 'Reporter';
  return 'Neighbour';
}

export async function getProfile(user) {
  if (!user) {
    return {
      id: 'guest',
      name: 'Neighbour',
      email: '',
      area: 'India',
      initials: 'NH',
      reports: 0,
      resolved: 0,
      helpfulVotes: 0,
      points: 0,
      rank: 18,
      badge: 'Guest',
      username: '',
      avatarId: 'hero',
      avatarUrl: null,
      peopleHelped: 0,
      role: 'citizen',
    };
  }
  const issues = await allIssues();
  const mine = issues.filter(
    (item) => item.reporter_id === user.id || item.reporter_name === user.name,
  );
  const resolved = mine.filter((item) => item.status === 'resolved').length;
  const helpful = mine.reduce((sum, item) => sum + (item.votes || 0), 0);
  const points = mine.length * 30 + resolved * 20 + helpful * 2;
  const board = await listLeaderboard();
  const rank = board.find((item) => item.id === user.id)?.rank || Math.max(3, 18 - mine.length);
  return {
    id: user.id || 'local-hero',
    name: user.name,
    email: user.email,
    area: user.area || 'India',
    initials: String(user.name || 'NH')
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
    reports: mine.length,
    resolved,
    helpfulVotes: helpful,
    points,
    rank,
    badge: badgeFor({ points, reports: mine.length, resolved, role: user.role }),
    username: user.username || user.name,
    avatarId: user.avatarId || 'hero',
    avatarUrl: user.avatarUrl || null,
    peopleHelped: Math.max(helpful, mine.length * 3),
    role: user.role || 'citizen',
  };
}

export async function updateSignedInUser(user) {
  await query(
    `update public.users
     set name = $2, username = $3, avatar_id = $4, avatar_url = $5
     where id = $1`,
    [user.id, user.name, user.username, user.avatarId || 'hero', user.avatarUrl || null],
  );
  return getUserById(user.id);
}

export async function updateProfile(input) {
  await query(
    `insert into public.profiles (id, name, email, area)
     values ('local-hero', $1, $2, $3)
     on conflict (id) do update set name = excluded.name, email = excluded.email, area = excluded.area`,
    [input.name?.trim() || 'Parth Patel', input.email?.trim() || '', input.area?.trim() || 'India'],
  );
  return getProfile();
}

export async function getSettings() {
  const result = await query('select * from public.settings where id = $1', ['local-hero']);
  const row = result.rows[0];
  if (!row) {
    return { language: 'English', notificationsEnabled: true, darkMode: true };
  }
  return {
    language: row.language,
    notificationsEnabled: row.notifications_enabled,
    darkMode: row.dark_mode,
  };
}

export async function updateSettings(input) {
  const current = await getSettings();
  const next = {
    language: input.language || current.language,
    notificationsEnabled:
      input.notificationsEnabled !== undefined
        ? Boolean(input.notificationsEnabled)
        : current.notificationsEnabled,
    darkMode: input.darkMode !== undefined ? Boolean(input.darkMode) : current.darkMode,
  };
  await query(
    `insert into public.settings (id, language, notifications_enabled, dark_mode)
     values ('local-hero', $1, $2, $3)
     on conflict (id) do update set
       language = excluded.language,
       notifications_enabled = excluded.notifications_enabled,
       dark_mode = excluded.dark_mode`,
    [next.language, next.notificationsEnabled, next.darkMode],
  );
  return next;
}

export async function getStats(user) {
  const profile = await getProfile(user);
  const notes = await noteRows(user);
  return {
    reports: profile.reports,
    resolved: profile.resolved,
    points: profile.points,
    peopleHelped: profile.peopleHelped,
    unread: notes.filter((item) => !(item.read || item.is_read)).length,
  };
}

export async function isUsernameTaken(username, exceptId) {
  const key = String(username || '').trim().toLowerCase();
  const result = exceptId
    ? await query(
        'select 1 from public.users where lower(username) = $1 and id <> $2 limit 1',
        [key, exceptId],
      )
    : await query('select 1 from public.users where lower(username) = $1 limit 1', [key]);
  return result.rows.length > 0;
}

export async function uniqueUsername(username) {
  const base =
    String(username || '')
      .replace(/\d+$/, '')
      .trim() || 'Hero';
  const joiner = base.includes(' ') ? ' ' : '';
  const next = () => `${base}${joiner}${Math.floor(10 + Math.random() * 90)}`;
  let candidate = String(username || '').trim() || next();
  let attempts = 0;
  while ((await isUsernameTaken(candidate)) && attempts < 80) {
    candidate = next();
    attempts += 1;
  }
  return candidate;
}

export async function publicUser(user) {
  if (!user) return null;
  return getProfile(user);
}

export async function createSession(userId) {
  const token = randomUUID();
  await query('insert into public.sessions (token, user_id, created_at) values ($1,$2,$3)', [
    token,
    userId,
    now(),
  ]);
  return token;
}

export async function getUserByToken(token) {
  if (!token) return null;
  const result = await query(
    `select u.* from public.sessions s
     join public.users u on u.id = s.user_id
     where s.token = $1`,
    [token],
  );
  return mapUser(result.rows[0]);
}

export async function findUserByEmail(email) {
  const result = await query('select * from public.users where lower(email) = lower($1)', [
    String(email || ''),
  ]);
  return mapUser(result.rows[0]);
}

export async function registerUser(input) {
  if (await findUserByEmail(input.email)) {
    throw new Error('An account with this email already exists');
  }
  if (!input.googleId && String(input.password || '').length < 6) {
    throw new Error('Password must be at least 6 characters');
  }
  const username = await uniqueUsername(input.username);
  const user = {
    id: randomUUID(),
    name: input.name,
    email: String(input.email).toLowerCase(),
    username,
    avatarId: input.avatarId || 'hero',
    avatarUrl: input.avatarUrl || null,
    googleId: input.googleId || null,
    passwordHash: input.password ? hashPassword(input.password) : null,
    area: input.area || 'India',
    role: input.role || 'citizen',
    created_at: now(),
  };
  await query(
    `insert into public.users (
       id, name, email, username, avatar_id, avatar_url, google_id, password_hash, area, role, created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      user.id,
      user.name,
      user.email,
      user.username,
      user.avatarId,
      user.avatarUrl,
      user.googleId,
      user.passwordHash,
      user.area,
      user.role,
      user.created_at,
    ],
  );
  if ((user.role || 'citizen') === 'citizen') {
    await pushNotification({
      userId: user.id,
      title: 'Welcome, NeighbourHero',
      body: 'You earned 10 coins. Your civic username is ready.',
      icon: 'trophy',
      type: 'welcome',
      coins: 10,
    });
  }
  return user;
}

export async function loginUser(email, password) {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error('Email or password is incorrect');
  }
  if (!user.passwordHash) {
    throw new Error('This account uses Google. Continue with Google instead.');
  }
  if (!checkPassword(password, user.passwordHash)) {
    throw new Error('Email or password is incorrect');
  }
  return user;
}

export async function upsertGoogleUser(input) {
  const byGoogle = await query('select * from public.users where google_id = $1', [input.googleId]);
  let user = mapUser(byGoogle.rows[0]) || (await findUserByEmail(input.email));
  if (user) {
    await query(
      `update public.users
       set google_id = $2, email = $3,
           name = coalesce(nullif($4, ''), name),
           avatar_url = coalesce(nullif($5, ''), avatar_url)
       where id = $1`,
      [user.id, input.googleId, input.email, input.name || '', input.avatarUrl || ''],
    );
    return getUserById(user.id);
  }
  return registerUser({
    name: input.name,
    email: input.email,
    username: await uniqueUsername(input.username || ''),
    avatarId: input.avatarId || 'hero',
    avatarUrl: input.avatarUrl,
    googleId: input.googleId,
    area: 'India',
  });
}

export async function logoutSession(token) {
  if (!token) return;
  await query('delete from public.sessions where token = $1', [token]);
}

function publicWorker(user, issues) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    area: user.area || 'India',
    assigned: issues.filter((item) => item.assigned_worker_id === user.id).length,
    open: issues.filter(
      (item) => item.assigned_worker_id === user.id && item.status !== 'resolved',
    ).length,
  };
}

export async function listAdminUsers() {
  const users = await allUsers();
  return users.filter((user) => user.role === 'admin');
}

export async function listWorkers() {
  const [users, issues] = await Promise.all([allUsers(), allIssues()]);
  return users
    .filter((user) => (user.role || 'citizen') === 'worker')
    .map((user) => publicWorker(user, issues));
}

function publicManagedUser(user, issues) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    area: user.area || 'India',
    role: user.role || 'citizen',
    reports: issues.filter((item) => item.reporter_id === user.id).length,
    assigned: issues.filter((item) => item.assigned_worker_id === user.id).length,
    open: issues.filter(
      (item) => item.assigned_worker_id === user.id && item.status !== 'resolved',
    ).length,
  };
}

export async function listManagedUsers() {
  const [users, issues] = await Promise.all([allUsers(), allIssues()]);
  return users
    .map((user) => publicManagedUser(user, issues))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateUserRole(userId, role, actorId) {
  const allowed = new Set(['citizen', 'worker', 'ngo']);
  if (!allowed.has(role)) {
    throw new Error('Invalid role');
  }
  const user = await getUserById(userId);
  if (!user) return null;
  if (user.id === actorId) {
    throw new Error('You cannot change your own role');
  }
  if (user.role === 'admin') {
    throw new Error('Super Admin accounts cannot be changed here');
  }
  await query(`update public.users set role = $2 where id = $1`, [userId, role]);
  const next = await getUserById(userId);
  return publicManagedUser(next, await allIssues());
}

export async function createWorker(input) {
  const user = await registerUser({
    name: input.name,
    email: input.email,
    username: input.username || input.name.replace(/\s+/g, ''),
    password: input.password,
    role: 'worker',
    area: input.area || 'India',
  });
  return publicWorker(user, await allIssues());
}

export async function assignIssue(issueId, workerId, admin) {
  const row = await getIssueRow(issueId);
  const workerResult = await query(
    `select * from public.users where id = $1 and role = 'worker'`,
    [workerId],
  );
  const worker = mapUser(workerResult.rows[0]);
  if (!row || !worker) return null;
  row.assigned_worker_id = worker.id;
  row.assigned_worker_name = worker.name;
  row.status = 'assigned';
  row.approval = 'none';
  row.citizen_verification = 'none';
  await saveIssueRow(row);
  await pushNotification({
    userId: worker.id,
    title: 'New Task Assigned',
    body: `You have been assigned a new ${row.category} report. Priority: ${row.priority}. Report ID: #${String(row.id).slice(0, 8).toUpperCase()}`,
    icon: 'flag',
    issueId: row.id,
    type: 'assign',
    coins: 0,
  });
  if (row.reporter_id) {
    await pushNotification({
      userId: row.reporter_id,
      title: 'A worker was assigned',
      body: `${worker.name} will handle “${row.title}”.`,
      icon: 'people',
      issueId: row.id,
      type: 'assign',
      coins: 0,
    });
  }
  return { issue: mapIssue(row), worker: publicWorker(worker, await allIssues()), admin: admin?.name };
}

export async function startIssue(issueId, worker) {
  const row = await getIssueRow(issueId);
  if (!row || !worker || row.assigned_worker_id !== worker.id) {
    return { error: 'This job is not assigned to you' };
  }
  if (!['assigned', 'pending', 'reopened'].includes(row.status)) {
    return { error: 'This task is already active or completed' };
  }
  const busy = await workerHasActiveJob(worker.id, row.id);
  if (busy) {
    return { error: 'Finish or release your current active task before starting another' };
  }
  row.status = 'in_progress';
  row.approval = 'none';
  await saveIssueRow(row);
  if (row.reporter_id) {
    await pushNotification({
      userId: row.reporter_id,
      title: 'Work started',
      body: `${worker.name} started work on “${row.title}”.`,
      icon: 'flag',
      issueId: row.id,
      type: 'in_progress',
      coins: 0,
    });
  }
  return { issue: mapIssue(row) };
}

export async function arriveIssue(issueId, worker, location = {}) {
  const row = await getIssueRow(issueId);
  if (!row || !worker || row.assigned_worker_id !== worker.id) {
    return { error: 'This job is not assigned to you' };
  }
  if (!['assigned', 'pending', 'in_progress', 'reopened'].includes(row.status)) {
    return { error: 'Arrival can only be confirmed for an active assigned task' };
  }
  const busy = await workerHasActiveJob(worker.id, row.id);
  if (busy && !ACTIVE_WORK.has(row.status)) {
    return { error: 'Finish or release your current active task before starting another' };
  }
  const lat = location.latitude != null ? Number(location.latitude) : null;
  const lng = location.longitude != null ? Number(location.longitude) : null;
  row.status = 'arrived';
  row.approval = 'none';
  row.arrived_at = now();
  row.arrived_lat = Number.isFinite(lat) ? lat : null;
  row.arrived_lng = Number.isFinite(lng) ? lng : null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    row.worker_lat = lat;
    row.worker_lng = lng;
    row.worker_location_at = now();
  }
  await saveIssueRow(row);
  if (row.reporter_id) {
    await pushNotification({
      userId: row.reporter_id,
      title: 'Worker arrived',
      body: `${worker.name} reached “${row.title}”.`,
      icon: 'flag',
      issueId: row.id,
      type: 'arrive',
      coins: 0,
    });
  }
  const admins = (await allUsers()).filter((user) => user.role === 'admin');
  for (const admin of admins) {
    await pushNotification({
      userId: admin.id,
      title: 'Worker arrived',
      body: `${worker.name} arrived at “${row.title}”.`,
      icon: 'flag',
      issueId: row.id,
      type: 'arrive',
      coins: 0,
    });
  }
  return { issue: mapIssue(row) };
}

export async function markRepairing(issueId, worker) {
  const row = await getIssueRow(issueId);
  if (!row || !worker || row.assigned_worker_id !== worker.id) {
    return { error: 'This job is not assigned to you' };
  }
  if (!['arrived', 'in_progress', 'repairing'].includes(row.status)) {
    return { error: 'Confirm arrival before starting repairs' };
  }
  row.status = 'repairing';
  await saveIssueRow(row);
  if (row.reporter_id) {
    await pushNotification({
      userId: row.reporter_id,
      title: 'Repair in progress',
      body: `${worker.name} is repairing “${row.title}”.`,
      icon: 'construct',
      issueId: row.id,
      type: 'repairing',
      coins: 0,
    });
  }
  return { issue: mapIssue(row) };
}

export async function updateWorkerLocation(issueId, worker, location = {}) {
  const row = await getIssueRow(issueId);
  if (!row || !worker || row.assigned_worker_id !== worker.id) {
    return { error: 'This job is not assigned to you' };
  }
  if (!ACTIVE_WORK.has(row.status)) {
    return { error: 'Location tracking is only available during active work' };
  }
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: 'Valid latitude and longitude are required' };
  }
  row.worker_lat = lat;
  row.worker_lng = lng;
  row.worker_location_at = now();
  await saveIssueRow(row);
  const meters = Math.round(
    haversineKm(
      { latitude: lat, longitude: lng },
      { latitude: Number(row.latitude), longitude: Number(row.longitude) },
    ) * 1000,
  );
  return { issue: mapIssue(row), distanceMeters: meters };
}

export async function submitProof(issueId, worker, input) {
  const row = await getIssueRow(issueId);
  if (!row || !worker || row.assigned_worker_id !== worker.id) {
    return { error: 'This job is not assigned to you' };
  }
  if (!ACTIVE_WORK.has(row.status) && row.status !== 'assigned') {
    return { error: 'Start and arrive at the task before submitting proof' };
  }
  row.proof_url = input.proofUrl;
  row.proof_path = input.proofPath;
  row.worker_note = input.note || '';
  row.status = 'repairing';
  row.approval = 'awaiting';
  row.completed_at = now();
  if (input.latitude != null && input.longitude != null) {
    row.worker_lat = Number(input.latitude);
    row.worker_lng = Number(input.longitude);
    row.worker_location_at = now();
  }
  await saveIssueRow(row);
  const admins = (await allUsers()).filter((user) => user.role === 'admin');
  for (const admin of admins) {
    await pushNotification({
      userId: admin.id,
      title: 'Proof waiting for approval',
      body: `${worker.name} submitted completion photos for “${row.title}”.`,
      icon: 'checkmark-circle',
      issueId: row.id,
      type: 'proof',
      coins: 0,
    });
  }
  return { issue: mapIssue(row) };
}

export async function reviewIssue(issueId, admin, decision) {
  const row = await getIssueRow(issueId);
  if (!row || !admin || admin.role !== 'admin') return null;
  const approved = decision === 'approved';
  row.approval = approved ? 'approved' : 'rejected';
  if (approved) {
    row.status = 'resolved';
    row.citizen_verification = 'pending';
    row.completed_at = row.completed_at || now();
  } else {
    row.status = 'reopened';
    row.citizen_verification = 'none';
  }
  await saveIssueRow(row);
  if (row.assigned_worker_id) {
    await pushNotification({
      userId: row.assigned_worker_id,
      title: approved ? 'Task approved' : 'Rework required',
      body: approved
        ? `“${row.title}” was approved. Waiting for citizen verification.`
        : `“${row.title}” needs additional work. Please revisit and submit new proof.`,
      icon: approved ? 'trophy' : 'flag',
      issueId: row.id,
      type: approved ? 'review_approved' : 'review_rejected',
      coins: approved ? 20 : 0,
    });
  }
  if (row.reporter_id) {
    await pushNotification({
      userId: row.reporter_id,
      title: approved ? 'Your Report Has Been Resolved' : 'Your report needs more work',
      body: approved
        ? `Your reported issue at ${row.address || 'the location'} has been resolved. Please verify the resolution.`
        : `Admin requested rework on “${row.title}”.`,
      icon: approved ? 'checkmark-circle' : 'flag',
      issueId: row.id,
      type: approved ? 'review_approved' : 'review_rejected',
      coins: approved ? 20 : 0,
    });
  }
  return { issue: mapIssue(row), coins: approved ? 20 : 0 };
}

export async function citizenVerifyIssue(issueId, user, decision, note = '') {
  const row = await getIssueRow(issueId);
  if (!row) return { error: 'Issue not found' };
  if (!user) return { error: 'Please sign in' };
  if (user.role === 'worker') {
    return { error: 'Workers cannot verify completed jobs' };
  }
  if (row.status !== 'resolved' || row.citizen_verification !== 'pending') {
    return { error: 'This report is not waiting for verification' };
  }
  const confirmed = decision === 'confirmed';
  if (confirmed) {
    row.citizen_verification = 'confirmed';
    row.citizen_verified_at = now();
    row.status = 'resolved';
  } else {
    row.citizen_verification = 'rejected';
    row.citizen_verified_at = now();
    row.status = 'reopened';
    row.approval = 'rejected';
    if (note) {
      row.worker_note = `${row.worker_note || ''}\nCitizen: ${note}`.trim();
    }
  }
  await saveIssueRow(row);

  const admins = (await allUsers()).filter((item) => item.role === 'admin');
  for (const admin of admins) {
    await pushNotification({
      userId: admin.id,
      title: confirmed ? 'Citizen verified resolution' : 'Citizen says problem still exists',
      body: confirmed
        ? `“${row.title}” was verified by the reporter.`
        : `“${row.title}” was reopened after citizen feedback.`,
      icon: confirmed ? 'checkmark-circle' : 'alert',
      issueId: row.id,
      type: confirmed ? 'citizen_verify' : 'citizen_reject',
      coins: 0,
    });
  }
  if (row.assigned_worker_id && !confirmed) {
    await pushNotification({
      userId: row.assigned_worker_id,
      title: 'Rework required',
      body: `Citizen reported that “${row.title}” is still unresolved.`,
      icon: 'flag',
      issueId: row.id,
      type: 'rework',
      coins: 0,
    });
  }
  return { issue: mapIssue(row) };
}

export async function adminOverview() {
  const issues = await allIssues();
  const mapped = issues.map(mapIssue);
  const workers = await listWorkers();
  return {
    reports: issues.length,
    pending: issues.filter((item) => item.status === 'pending' || item.status === 'reopened').length,
    assigned: issues.filter((item) => item.status === 'assigned').length,
    inProgress: issues.filter((item) => ACTIVE_WORK.has(item.status)).length,
    awaiting: issues.filter((item) => item.approval === 'awaiting').length,
    waitingCitizen: issues.filter((item) => item.citizen_verification === 'pending').length,
    resolved: issues.filter((item) => item.status === 'resolved').length,
    workers: workers.length,
    slaBreached: mapped.filter((item) => item.slaBreached).length,
    ngoVerified: mapped.filter((item) => item.ngoVerified).length,
  };
}

export async function listLeaderboard() {
  const users = await allUsers();
  const issues = await allIssues();
  const citizens = users.filter((user) => (user.role || 'citizen') === 'citizen');
  const rows = citizens.map((person) => {
    const mine = issues.filter(
      (item) => item.reporter_id === person.id || item.reporter_name === person.name,
    );
    const resolved = mine.filter((item) => item.status === 'resolved').length;
    const helpful = mine.reduce((sum, item) => sum + (item.votes || 0), 0);
    const points = mine.length * 30 + resolved * 20 + helpful * 2;
    return {
      id: person.id,
      name: person.name,
      username: person.username || person.name,
      area: person.area || 'India',
      reports: mine.length,
      resolved,
      points,
      badge: badgeFor({ points, reports: mine.length, resolved, role: person.role }),
    };
  });
  return rows
    .sort((a, b) => b.points - a.points)
    .map((item, index) => ({ ...item, rank: index + 1 }))
    .slice(0, 20);
}

export async function listHotspots() {
  const issues = await allIssues();
  const buckets = new Map();
  issues.forEach((item) => {
    const lat = Math.round(Number(item.latitude) * 100) / 100;
    const lng = Math.round(Number(item.longitude) * 100) / 100;
    const key = `${lat},${lng}`;
    const current = buckets.get(key) || {
      id: key,
      latitude: lat,
      longitude: lng,
      count: 0,
      open: 0,
      categories: {},
    };
    current.count += 1;
    if (item.status !== 'resolved') current.open += 1;
    current.categories[item.category] = (current.categories[item.category] || 0) + 1;
    buckets.set(key, current);
  });
  return [...buckets.values()]
    .map((item) => ({
      ...item,
      topCategory: Object.entries(item.categories).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other',
    }))
    .sort((a, b) => b.open - a.open || b.count - a.count)
    .slice(0, 12);
}

export async function listSlaBoard() {
  const issues = await allIssues();
  return issues
    .map(mapIssue)
    .filter((item) => item.status !== 'resolved')
    .sort(
      (a, b) => Number(b.slaBreached) - Number(a.slaBreached) || new Date(a.dueAt) - new Date(b.dueAt),
    );
}

export async function listEvents() {
  const result = await query('select * from public.events order by starts_at asc');
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    area: row.area,
    startsAt: iso(row.starts_at),
    createdBy: row.created_by,
    createdById: row.created_by_id,
    created_at: iso(row.created_at),
  }));
}

export async function createEvent(input, user) {
  const row = {
    id: randomUUID(),
    title: input.title,
    description: input.description || '',
    area: input.area || user?.area || 'Local neighbourhood',
    startsAt: input.startsAt || now(),
    createdBy: user?.name || 'NGO',
    createdById: user?.id || null,
    created_at: now(),
  };
  await query(
    `insert into public.events (id, title, description, area, starts_at, created_by, created_by_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.id,
      row.title,
      row.description,
      row.area,
      row.startsAt,
      row.createdBy,
      row.createdById,
      row.created_at,
    ],
  );
  return row;
}

export async function verifyIssue(issueId, user) {
  const row = await getIssueRow(issueId);
  if (!row) return null;
  row.ngo_verified = true;
  await saveIssueRow(row);
  if (row.reporter_id && row.reporter_id !== user?.id) {
    try {
      await pushNotification({
        userId: row.reporter_id,
        title: 'Your report was verified',
        body: `${user?.name || 'A neighbour'} confirmed “${row.title}”.`,
        icon: 'checkmark-circle',
        issueId: row.id,
        type: 'community',
        coins: 0,
      });
    } catch (error) {
      console.error('verify notification failed', error);
    }
  }
  return { issue: mapIssue(row) };
}

async function ensureStaffAccounts() {
  const staff = [
    {
      name: 'Parth Patel',
      email: 'neighbour@neighbourhero.app',
      username: 'ParthPatel',
      password: 'neighbour123',
      role: 'citizen',
      area: 'Ahmedabad',
    },
    {
      name: 'Super Admin',
      email: 'admin@neighbourhero.app',
      username: 'CityAdmin',
      password: 'admin123',
      role: 'admin',
      area: 'Ahmedabad',
    },
    {
      name: 'Rahul Mehta',
      email: 'worker@neighbourhero.app',
      username: 'FieldWorker',
      password: 'worker123',
      role: 'worker',
      area: 'Ahmedabad',
    },
    {
      name: 'Road Crew',
      email: 'crew@neighbourhero.app',
      username: 'RoadCrew',
      password: 'crew123',
      role: 'worker',
      area: 'Ahmedabad',
    },
    {
      name: 'Green Society',
      email: 'ngo@neighbourhero.app',
      username: 'GreenSociety',
      password: 'ngo123',
      role: 'ngo',
      area: 'Ahmedabad',
    },
  ];
  for (const item of staff) {
    const existing = await findUserByEmail(item.email);
    const passwordHash = hashPassword(item.password);
    if (existing) {
      await query(
        `update public.users
         set role = $2, password_hash = $3, name = $4, area = $5
         where id = $1`,
        [existing.id, item.role, passwordHash, item.name, item.area],
      );
      continue;
    }
    await registerUser(item);
  }
}

export async function initDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing. The API now stores all data in Supabase.');
  }
  pool = await getPool();
  await ensureStaffAccounts();
  return 'supabase';
}
