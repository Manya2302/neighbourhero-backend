import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPostgres } from './pg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.log('No DATABASE_URL. Local API store will still work for the demo.');
  process.exit(0);
}

let client;
try {
  client = await connectPostgres();
} catch (error) {
  console.warn(
    'Could not reach Supabase. The local NeighbourHero API still works for the demo.',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
await client.query(schema);
console.log(
  'Updated Supabase tables: profiles, settings, users, sessions, issues, comments, notifications, events.',
);

try {
  const storage = fs.readFileSync(path.join(__dirname, 'storage.sql'), 'utf8');
  await client.query(storage);
  console.log('Created Supabase Storage bucket issue-photos.');
} catch (error) {
  console.warn(
    'Issues table is ready, but the Storage bucket could not be created from SQL.',
    error instanceof Error ? error.message : error,
  );
}

await client.end();
console.log('Database migration finished.');
