import pg from 'pg';

function parseDatabaseUrl(url) {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
    hostname: parsed.hostname,
    original: url,
  };
}

function connectionCandidates(databaseUrl) {
  const parsed = parseDatabaseUrl(databaseUrl);
  const ref = parsed.hostname.startsWith('db.')
    ? parsed.hostname.split('.')[1]
    : 'shgohauomhqmkyverehi';
  const encoded = encodeURIComponent(parsed.password);
  return [
    { label: 'DATABASE_URL (direct)', config: { connectionString: databaseUrl, ssl: { rejectUnauthorized: false } } },
    {
      label: 'pooler ap-south-1:6543',
      config: {
        connectionString: `postgresql://postgres.${ref}:${encoded}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`,
        ssl: { rejectUnauthorized: false },
      },
    },
    {
      label: 'pooler ap-south-1:5432',
      config: {
        connectionString: `postgresql://postgres.${ref}:${encoded}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
        ssl: { rejectUnauthorized: false },
      },
    },
    {
      label: 'pooler ap-northeast-1:5432',
      config: {
        connectionString: `postgresql://postgres.${ref}:${encoded}@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
        ssl: { rejectUnauthorized: false },
      },
    },
    {
      label: 'pooler ap-southeast-1:5432',
      config: {
        connectionString: `postgresql://postgres.${ref}:${encoded}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
        ssl: { rejectUnauthorized: false },
      },
    },
  ];
}

export async function connectPostgres() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is missing');
  }

  const errors = [];
  for (const candidate of connectionCandidates(databaseUrl)) {
    const client = new pg.Client({
      ...candidate.config,
      connectionTimeoutMillis: 12000,
    });
    try {
      await client.connect();
      console.log(`Connected to Supabase via ${candidate.label}.`);
      client.__label = candidate.label;
      client.__config = candidate.config;
      return client;
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : error}`);
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }

  throw new Error(`Could not reach Supabase.\n${errors.join('\n')}`);
}

let pool;

export async function getPool() {
  if (pool) return pool;
  const client = await connectPostgres();
  const config = client.__config;
  const label = client.__label;
  await client.end();
  pool = new pg.Pool({
    ...config,
    max: 8,
    connectionTimeoutMillis: 12000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (error) => {
    console.warn('Supabase pool error', error instanceof Error ? error.message : error);
  });
  console.log(`API data pool ready (${label}).`);
  return pool;
}
