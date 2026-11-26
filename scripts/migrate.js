'use strict';

/**
 * Applies SQL migration files through the Supabase Management API.
 * Usage: npm run migrate
 *
 * Requires SUPABASE_URL and SUPABASE_ACCESS_TOKEN in backend/.env.
 * This is intentionally separate from the runtime service-role client:
 * DDL must never be exposed by the application server.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const projectUrl = process.env.SUPABASE_URL;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

if (!projectUrl || !accessToken) {
  console.error('Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN in backend/.env');
  process.exit(1);
}

const projectRef = projectUrl.replace(/^https?:\/\//, '').split('.')[0];
const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

async function runSql(sql) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`SQL failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

(async () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    process.stdout.write(`Applying ${file}... `);
    try {
      await runSql(sql);
      console.log('OK');
    } catch (error) {
      console.error('FAILED');
      console.error(error.message);
      process.exit(1);
    }
  }

  const tables = await runSql(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
  );
  const counts = await runSql(
    "select 'avatars' as table_name, count(*)::int as rows from public.avatars " +
    "union all select 'banners', count(*)::int from public.banners " +
    "union all select 'topup_packages', count(*)::int from public.topup_packages " +
    "union all select 'achievements', count(*)::int from public.achievements " +
    "union all select 'app_settings', count(*)::int from public.app_settings"
  );

  console.log('\nPublic tables:', tables.map((row) => row.table_name).join(', '));
  console.log('Seed counts:', JSON.stringify(counts));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
