import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import * as db from './db.mjs';
import { classifyCivicPhoto } from './vision.mjs';
import { verifyGoogleIdToken } from './google.mjs';
import {
  randomAvatarId,
  randomIndianName,
  randomUsername,
} from './identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

const CATEGORIES = [
  'Pothole',
  'Road Damage',
  'Broken Street Lights',
  'Electrical Problems',
  'Garbage/Waste',
  'Water Leakage',
  'Drainage Problems',
  'Sewage Problems',
  'Traffic Signal Problems',
  'Broken Footpaths',
  'Damaged Public Infrastructure',
  'Highway Problems',
  'Public Toilet Problems',
  'Illegal Dumping',
  'Fallen Trees',
  'Road Blockage',
  'Water Supply Problems',
  'Public Property Damage',
  'Construction Hazards',
  'Streetlight',
  'Water leak',
  'Road damage',
  'Garbage',
  'Other',
];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

function readToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

app.use(async (req, _res, next) => {
  req.user = await db.getUserByToken(readToken(req));
  next();
});

function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'Please sign in' });
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  if (!requireUser(req, res)) return false;
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

function requireWorker(req, res) {
  if (!requireUser(req, res)) return false;
  if (req.user.role !== 'worker') {
    res.status(403).json({ error: 'Worker access required' });
    return false;
  }
  return true;
}

function requireNgo(req, res) {
  if (!requireUser(req, res)) return false;
  if (req.user.role !== 'ngo' && req.user.role !== 'admin') {
    res.status(403).json({ error: 'NGO access required' });
    return false;
  }
  return true;
}

function publicApiBase(req) {
  const configured = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim();
  if (host && !host.startsWith('127.') && !host.startsWith('localhost')) {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  return configured || `http://127.0.0.1:${process.env.PORT || 3001}`;
}

async function savePhotoFile(file, req) {
  const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
  const photoPath = `${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
  const publicBase = publicApiBase(req);
  let photoUrl = `${publicBase.replace(/\/$/, '')}/uploads/${photoPath}`;
  if (supabase) {
    const { error: uploadError } = await supabase.storage
      .from('issue-photos')
      .upload(photoPath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
    if (uploadError) throw new Error('Could not store photo in Supabase Storage');
    photoUrl = supabase.storage.from('issue-photos').getPublicUrl(photoPath).data.publicUrl;
  } else {
    fs.writeFileSync(path.join(uploadsDir, photoPath), file.buffer);
  }
  return { photoUrl, photoPath };
}

let dataBackend = 'starting';

app.get('/', (_req, res) => {
  res.json({
    status: 'online',
    service: 'NeighbourHero API',
    database: dataBackend,
    time: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    storage: supabase ? 'supabase' : 'local',
    data: dataBackend,
  });
});

app.get('/stats', async (req, res) => {
  res.json(await db.getStats(req.user));
});

app.get('/profile', async (req, res) => {
  res.json({ profile: await db.getProfile(req.user) });
});

app.patch('/profile', async (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Please sign in' });
    return;
  }
  req.user.name = req.body.name?.trim() || req.user.name;
  req.user.username = req.body.username?.trim() || req.user.username;
  req.user.avatarId = req.body.avatarId || req.user.avatarId;
  if (req.body.avatarUrl !== undefined) req.user.avatarUrl = req.body.avatarUrl;
  await db.updateSignedInUser(req.user);
  await db.pushNotification({
    userId: req.user.id,
    title: 'Profile saved',
    body: 'Your NeighbourHero profile is up to date.',
    icon: 'person',
    type: 'profile',
    coins: 0,
  });
  res.json({ profile: await db.getProfile(req.user) });
});

app.get('/auth/suggest', async (req, res) => {
  const style = req.query.style === 'long' ? 'long' : 'short';
  const username = await db.uniqueUsername(randomUsername(style));
  res.json({
    name: randomIndianName(),
    username,
    avatarId: randomAvatarId(),
  });
});

app.post('/auth/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!name || !email || !username) {
      res.status(400).json({ error: 'Name, email, and username are required' });
      return;
    }
    const user = await db.registerUser({
      name,
      email,
      username,
      password,
      avatarId: req.body.avatarId,
      avatarUrl: req.body.avatarUrl,
    });
    const token = await db.createSession(user.id);
    res.status(201).json({ token, profile: await db.getProfile(user) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not register' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const user = await db.loginUser(
      String(req.body.email || '').trim().toLowerCase(),
      String(req.body.password || ''),
    );
    const token = await db.createSession(user.id);
    res.json({ token, profile: await db.getProfile(user) });
  } catch (error) {
    res.status(401).json({
      error: error instanceof Error ? error.message : 'Could not sign in',
    });
  }
});

app.get('/auth/me', async (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Please sign in' });
    return;
  }
  res.json({ profile: await db.getProfile(req.user) });
});

app.post('/auth/avatar', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'A photo is required' });
      return;
    }
    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const photoPath = `avatar-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, photoPath), req.file.buffer);
    const publicBase = publicApiBase(req);
    res.json({ url: `${publicBase.replace(/\/$/, '')}/uploads/${photoPath}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not save photo' });
  }
});

app.get('/auth/google/callback', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="font-family:sans-serif;padding:24px">
    <p>Signed in. Return to NeighbourHero.</p>
    <script>
      var hash = new URLSearchParams(location.hash.replace(/^#/, ''));
      var query = new URLSearchParams(location.search);
      var idToken = hash.get('id_token') || query.get('id_token');
      if (idToken) {
        location.replace('neighbourhero://oauthredirect#id_token=' + encodeURIComponent(idToken));
      }
    </script>
  </body>
</html>`);
});

app.post('/auth/google', async (req, res) => {
  try {
    const google = await verifyGoogleIdToken(req.body.idToken);
    const user = await db.upsertGoogleUser({
      googleId: google.googleId,
      email: google.email,
      name: req.body.name || google.name,
      username: req.body.username,
      avatarId: req.body.avatarId,
      avatarUrl: req.body.avatarUrl || google.picture,
    });
    const token = await db.createSession(user.id);
    res.json({ token, profile: await db.getProfile(user) });
  } catch (error) {
    res.status(401).json({
      error: error instanceof Error ? error.message : 'Google sign-in failed',
    });
  }
});

app.post('/auth/logout', async (req, res) => {
  await db.logoutSession(readToken(req));
  res.json({ ok: true });
});

app.get('/settings', async (_req, res) => {
  res.json({ settings: await db.getSettings() });
});

app.patch('/settings', async (req, res) => {
  res.json({ settings: await db.updateSettings(req.body || {}) });
});

app.get('/notifications', async (req, res) => {
  res.json({ notifications: await db.listNotifications(req.user) });
});

app.post('/notifications/read', async (req, res) => {
  res.json({ notifications: await db.markNotificationsRead(req.user) });
});

app.get('/live', async (req, res) => {
  res.json(await db.listLive(req.user, req.query.since));
});

app.get('/issues', async (_req, res) => {
  res.json({ issues: await db.listIssues() });
});

app.get('/issues/duplicates', async (req, res) => {
  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.status(400).json({ error: 'Current location is required' });
    return;
  }
  res.json({
    matches: await db.findNearbyDuplicates({
      latitude,
      longitude,
      category: req.query.category,
      radiusKm: req.query.radiusKm,
    }),
  });
});

app.get('/leaderboard', async (_req, res) => {
  res.json({ leaders: await db.listLeaderboard() });
});

app.get('/events', async (_req, res) => {
  res.json({ events: await db.listEvents() });
});

app.post('/events', async (req, res) => {
  if (!requireNgo(req, res)) return;
  const title = String(req.body.title || '').trim();
  if (!title) {
    res.status(400).json({ error: 'Title and description are required' });
    return;
  }
  const event = await db.createEvent(
    {
      title,
      description: String(req.body.description || '').trim(),
      area: String(req.body.area || '').trim(),
      startsAt: req.body.startsAt,
    },
    req.user,
  );
  res.status(201).json({ event });
});

app.post('/ai/classify', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'A photo is required' });
      return;
    }
    const hint = `${req.body.title || ''} ${req.body.description || ''}`;
    const result = await classifyCivicPhoto(req.file.buffer, req.file.mimetype, hint);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not classify photo' });
  }
});

app.get('/issues/:id', async (req, res) => {
  const issue = await db.getIssue(req.params.id);
  if (!issue) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  res.json({
    issue,
    comments: await db.listComments(req.params.id),
  });
});

app.get('/issues/:id/comments', async (req, res) => {
  res.json({ comments: await db.listComments(req.params.id) });
});

app.post('/issues/:id/comments', async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) {
    res.status(400).json({ error: 'Comment cannot be empty' });
    return;
  }
  const comment = await db.addComment(
    req.params.id,
    body,
    req.user?.username || req.user?.name || 'Neighbour',
    req.user?.id,
  );
  if (!comment) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  res.status(201).json({ comment });
});

app.post('/issues', upload.single('photo'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const category = String(req.body.category || '');
    const priority = String(req.body.priority || 'Medium');
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);

    if (!title || !description) {
      res.status(400).json({ error: 'Title and description are required' });
      return;
    }
    if (!CATEGORIES.includes(category)) {
      res.status(400).json({ error: 'Invalid category' });
      return;
    }
    if (!PRIORITIES.includes(priority)) {
      res.status(400).json({ error: 'Invalid priority' });
      return;
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      res.status(400).json({ error: 'Current location is required' });
      return;
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      res.status(400).json({ error: 'Location looks invalid' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'A photo is required' });
      return;
    }

    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const photoPath = `${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
    const publicBase = publicApiBase(req);
    let photoUrl = `${publicBase.replace(/\/$/, '')}/uploads/${photoPath}`;

    if (supabase) {
      const { error: uploadError } = await supabase.storage
        .from('issue-photos')
        .upload(photoPath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });
      if (uploadError) {
        console.error(uploadError);
        res.status(500).json({ error: 'Could not store photo in Supabase Storage' });
        return;
      }
      photoUrl = supabase.storage.from('issue-photos').getPublicUrl(photoPath).data
        .publicUrl;
    } else {
      fs.writeFileSync(path.join(uploadsDir, photoPath), req.file.buffer);
    }

    const created = await db.createIssueRecord({
      title,
      description,
      category,
      priority,
      latitude,
      longitude,
      address: String(req.body.address || req.body.locationLabel || '').trim() || null,
      photoUrl,
      photoPath,
      reporterName: req.user?.username || req.user?.name,
      reporterId: req.user?.id || null,
      mergeInto: req.body.mergeInto || null,
      autoMerge: String(req.body.autoMerge || '') === 'true',
      aiCategory: req.body.aiCategory || null,
      aiConfidence: req.body.aiConfidence ? Number(req.body.aiConfidence) : null,
    });

    try {
      const admins = await db.listAdminUsers();
      for (const admin of admins) {
        await db.pushNotification({
          userId: admin.id,
          title:
            priority === 'Critical' || priority === 'High'
              ? 'High-priority problem reported'
              : 'New problem reported',
          body: `${title} · ${category} · ${priority}`,
          icon: 'alert',
          issueId: created.issue?.id,
          type: 'report',
          coins: 0,
        });
      }
    } catch (notifyError) {
      console.warn('Admin notify skipped', notifyError);
    }

    res.status(201).json(created);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not save report' });
  }
});

app.post('/issues/:id/vote', async (req, res) => {
  const result = await db.voteIssue(req.params.id, req.user);
  if (!result) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  res.json(result);
});

app.post('/issues/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const status = String(req.body.status || '');
  if (
    !['pending', 'assigned', 'in_progress', 'arrived', 'repairing', 'resolved', 'reopened'].includes(
      status,
    )
  ) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }
  const result = await db.setIssueStatus(req.params.id, status);
  if (!result) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  res.json(result);
});

app.get('/staff/overview', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(await db.adminOverview());
});

app.get('/staff/hotspots', async (req, res) => {
  if (!requireUser(req, res)) return;
  if (!['admin', 'ngo'].includes(req.user.role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  res.json({ hotspots: await db.listHotspots() });
});

app.get('/staff/sla', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ issues: await db.listSlaBoard() });
});

app.post('/issues/:id/verify', async (req, res) => {
  if (!requireUser(req, res)) return;
  if (req.user.role === 'worker') {
    res.status(403).json({ error: 'Workers cannot verify community reports' });
    return;
  }
  try {
    const result = await db.verifyIssue(req.params.id, req.user);
    if (!result) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Could not verify report',
    });
  }
});

app.get('/staff/workers', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ workers: await db.listWorkers() });
});

app.get('/staff/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ users: await db.listManagedUsers() });
});

app.patch('/staff/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const user = await db.updateUserRole(req.params.id, String(req.body.role || ''), req.user.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update role' });
  }
});

app.post('/staff/workers', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !email || password.length < 6) {
      res.status(400).json({ error: 'Name, email, and password (min 6) are required' });
      return;
    }
    const worker = await db.createWorker({ name, email, password, username: req.body.username });
    res.status(201).json({ worker });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add worker' });
  }
});

app.post('/issues/:id/assign', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await db.assignIssue(req.params.id, String(req.body.workerId || ''), req.user);
  if (!result) {
    res.status(404).json({ error: 'Issue or worker not found' });
    return;
  }
  res.json(result);
});

app.post('/issues/:id/arrive', async (req, res) => {
  if (!requireWorker(req, res)) return;
  const result = await db.arriveIssue(req.params.id, req.user, {
    latitude: req.body.latitude,
    longitude: req.body.longitude,
  });
  if (result?.error) {
    res.status(403).json({ error: result.error });
    return;
  }
  if (!result?.issue) {
    res.status(403).json({ error: 'This job is not assigned to you' });
    return;
  }
  res.json(result);
});

app.post('/issues/:id/start', async (req, res) => {
  if (!requireWorker(req, res)) return;
  const result = await db.startIssue(req.params.id, req.user);
  if (result?.error) {
    res.status(403).json({ error: result.error });
    return;
  }
  if (!result?.issue) {
    res.status(403).json({ error: 'This job is not assigned to you' });
    return;
  }
  res.json(result);
});

app.post('/issues/:id/repairing', async (req, res) => {
  if (!requireWorker(req, res)) return;
  const result = await db.markRepairing(req.params.id, req.user);
  if (result?.error) {
    res.status(403).json({ error: result.error });
    return;
  }
  if (!result?.issue) {
    res.status(403).json({ error: 'This job is not assigned to you' });
    return;
  }
  res.json(result);
});

app.post('/issues/:id/location', async (req, res) => {
  if (!requireWorker(req, res)) return;
  const result = await db.updateWorkerLocation(req.params.id, req.user, {
    latitude: req.body.latitude,
    longitude: req.body.longitude,
  });
  if (result?.error) {
    res.status(403).json({ error: result.error });
    return;
  }
  if (!result?.issue) {
    res.status(403).json({ error: 'This job is not assigned to you' });
    return;
  }
  res.json(result);
});

app.post('/issues/:id/citizen-verify', async (req, res) => {
  if (!requireUser(req, res)) return;
  if (req.user.role === 'worker') {
    res.status(403).json({ error: 'Workers cannot verify completed jobs' });
    return;
  }
  const decision = String(req.body.decision || '');
  if (!['confirmed', 'rejected'].includes(decision)) {
    res.status(400).json({ error: 'Choose confirmed or rejected' });
    return;
  }
  try {
    const result = await db.citizenVerifyIssue(
      req.params.id,
      req.user,
      decision,
      String(req.body.note || '').trim(),
    );
    if (result?.error) {
      res.status(403).json({ error: result.error });
      return;
    }
    if (!result?.issue) {
      res.status(404).json({ error: 'Issue not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Could not verify resolution',
    });
  }
});

app.post('/issues/:id/proof', upload.single('photo'), async (req, res) => {
  if (!requireWorker(req, res)) return;
  try {
    if (!req.file) {
      res.status(400).json({ error: 'A photo is required' });
      return;
    }
    const saved = await savePhotoFile(req.file, req);
    const result = await db.submitProof(req.params.id, req.user, {
      proofUrl: saved.photoUrl,
      proofPath: saved.photoPath,
      note: String(req.body.note || '').trim(),
      latitude: req.body.latitude,
      longitude: req.body.longitude,
    });
    if (result?.error) {
      res.status(403).json({ error: result.error });
      return;
    }
    if (!result?.issue) {
      res.status(403).json({ error: 'This job is not assigned to you' });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not save photo' });
  }
});

app.post('/issues/:id/review', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const decision = String(req.body.decision || '');
  if (!['approved', 'rejected'].includes(decision)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }
  const result = await db.reviewIssue(req.params.id, req.user, decision);
  if (!result) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  res.json(result);
});

if (supabase) {
  console.log('Photo uploads will use Supabase Storage (issue-photos).');
} else {
  console.warn('Photos are stored on this API. Add SUPABASE_SERVICE_ROLE_KEY to use Storage.');
}

const port = Number(process.env.PORT || 3001);

try {
  dataBackend = await db.initDb();
  console.log('API data store: Supabase Postgres.');
} catch (error) {
  console.error('Could not connect the API to Supabase.', error instanceof Error ? error.message : error);
  process.exit(1);
}

app.listen(port, '0.0.0.0', () => {
  console.log(`NeighbourHero API listening on ${port}`);
});
