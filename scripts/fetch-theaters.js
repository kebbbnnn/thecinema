#!/usr/bin/env node

/**
 * The Cinema — Theater Data Pipeline
 * Fetches movie theater data for all Philippine provinces/cities
 * and stores snapshots + fetch logs in Cloudflare D1.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 55 Locations: 40 Provinces + 15 Cities
const PROVINCES = [
  // 40 Provinces
  'agusan-del-norte',
  'aklan',
  'albay',
  'antique',
  'baguio',
  'bataan',
  'batangas',
  'bukidnon',
  'bulacan',
  'cagayan',
  'camarines-norte',
  'camarines-sur',
  'capiz',
  'cavite',
  'cebu',
  'davao-del-norte',
  'davao-del-sur',
  'ilocos-norte',
  'iloilo',
  'isabela',
  'la-union',
  'laguna',
  'lanao-del-norte',
  'leyte',
  'maguindanao-del-norte',
  'misamis-oriental',
  'negros-occidental',
  'negros-oriental',
  'nueva-ecija',
  'oriental-mindoro',
  'palawan',
  'pampanga',
  'pangasinan',
  'quezon',
  'rizal',
  'sorsogon',
  'south-cotabato',
  'tarlac',
  'zambales',
  'zamboanga-del-sur',

  // 15 Cities
  'caloocan',
  'las-pinas',
  'makati',
  'malabon',
  'mandaluyong',
  'manila',
  'marikina',
  'muntinlupa',
  'paranaque',
  'pasay',
  'pasig',
  'quezon-city',
  'san-juan',
  'taguig',
  'valenzuela',
];

const CONCURRENCY_LIMIT = 5;

/**
 * Computes the date and run type based on Philippine Standard Time (UTC+8).
 */
function getPHTInfo(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const snapshotDate = formatter.format(date); // Format: YYYY-MM-DD

  const hourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    hour12: false,
  });
  const phtHour = parseInt(hourFormatter.format(date), 10);

  // Manual run type override via env or CLI flag, else time-based:
  // 00:00 - 03:59 PHT -> 'initial' (midnight run)
  // 04:00+ PHT -> 'refresh' (6am run or later)
  let runType = process.env.RUN_TYPE;
  if (!runType) {
    runType = phtHour < 4 ? 'initial' : 'refresh';
  }

  return { snapshotDate, phtHour, runType };
}

/**
 * Escapes values safely for SQLite queries.
 */
function sqlEscape(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return isNaN(val) ? 'NULL' : String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * Helper to limit concurrent asynchronous tasks.
 */
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await fn(items[currentIndex], currentIndex);
      } catch (err) {
        results[currentIndex] = {
          slug: items[currentIndex],
          success: false,
          error: err.message || String(err),
          theaters: [],
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Fetches movie theater data for a single province/city with retries.
 */
async function fetchProvince(slug, retries = 3) {
  const baseUrl = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('API_BASE_URL environment variable is required.');
  }
  const url = `${baseUrl}/movies/province/${slug}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'TheCinema-D1-Pipeline/1.0',
          Accept: 'application/json',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      return {
        slug,
        success: true,
        locationName: data.location_name || slug,
        theaters: Array.isArray(data.theaters) ? data.theaters : [],
      };
    } catch (err) {
      if (attempt === retries) {
        return {
          slug,
          success: false,
          error: err.message || String(err),
          theaters: [],
        };
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}

/**
 * Main execution function.
 */
async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
  const isLocal = args.includes('--local') || process.env.USE_LOCAL_DB === 'true';
  const dbName = process.env.D1_DATABASE_NAME || 'thecinema-db';

  const { snapshotDate, phtHour, runType } = getPHTInfo();

  console.log('='.repeat(60));
  console.log(`🎬 The Cinema — D1 Pipeline`);
  console.log(`📅 Snapshot Date (PHT): ${snapshotDate}`);
  console.log(`⏰ Current PHT Hour:     ${phtHour}:00`);
  console.log(`🔄 Run Type:             ${runType.toUpperCase()}`);
  console.log(`🎯 Target DB:            ${dbName} (${isLocal ? 'local' : 'remote'})`);
  console.log(`🧪 Mode:                 ${isDryRun ? 'DRY-RUN (no DB write)' : 'LIVE'}`);
  console.log(`📍 Total Locations:      ${PROVINCES.length}`);
  console.log('='.repeat(60));

  console.log(`\n⏳ Fetching data from API (concurrency: ${CONCURRENCY_LIMIT})...`);
  const startTime = Date.now();

  const results = await mapConcurrent(PROVINCES, CONCURRENCY_LIMIT, async (slug) => {
    const res = await fetchProvince(slug);
    const count = res.theaters ? res.theaters.length : 0;
    if (res.success) {
      console.log(`  ✓ [${slug}] ${res.locationName}: ${count} theater(s)`);
    } else {
      console.error(`  ✗ [${slug}] FAILED: ${res.error}`);
    }
    return res;
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const totalTheaters = successful.reduce((acc, r) => acc + r.theaters.length, 0);

  console.log('\n' + '-'.repeat(60));
  console.log(`📊 Fetch Summary:`);
  console.log(`   - Successful:    ${successful.length}/${PROVINCES.length} locations`);
  console.log(`   - Failed:        ${failed.length}/${PROVINCES.length} locations`);
  console.log(`   - Total Theaters: ${totalTheaters}`);
  console.log(`   - Time Taken:    ${durationSec}s`);
  console.log('-'.repeat(60));

  if (successful.length === 0) {
    console.error('❌ All province fetches failed. Aborting database write.');
    process.exit(1);
  }

  // Build SQL statements
  const statements = [];

  for (const result of results) {
    const { slug, success, locationName, theaters, error } = result;

    // For 'refresh' runs (e.g. 6:00 AM PHT), replace existing entries for today + province
    if (runType === 'refresh') {
      statements.push(
        `DELETE FROM theater_snapshots WHERE snapshot_date = ${sqlEscape(snapshotDate)} AND province_slug = ${sqlEscape(slug)};`
      );
    }

    if (success) {
      for (const t of theaters) {
        const logo = t.logo_url || t.logo || t.branch_logo || null;
        const buyTicket = t.buy_ticket ? 1 : 0;
        const provinceDisplay = t.province || locationName || slug;

        statements.push(
          `INSERT INTO theater_snapshots (` +
            `snapshot_date, province_slug, theater_id, theater_type, slug, branch_id, name, ` +
            `address1, address2, city, logo_url, longitude, latitude, buy_ticket, mall_group_id, province` +
          `) VALUES (` +
            `${sqlEscape(snapshotDate)}, ${sqlEscape(slug)}, ${sqlEscape(t.id)}, ${sqlEscape(t.theater_type)}, ` +
            `${sqlEscape(t.slug)}, ${sqlEscape(t.branch_id)}, ${sqlEscape(t.name)}, ${sqlEscape(t.address1)}, ` +
            `${sqlEscape(t.address2)}, ${sqlEscape(t.city)}, ${sqlEscape(logo)}, ${sqlEscape(t.longitude)}, ` +
            `${sqlEscape(t.latitude)}, ${buyTicket}, ${sqlEscape(t.mall_group_id)}, ${sqlEscape(provinceDisplay)}` +
          `);`
        );
      }

      statements.push(
        `INSERT INTO fetch_log (` +
          `snapshot_date, run_type, province_slug, location_name, theater_count, status, error_message` +
        `) VALUES (` +
          `${sqlEscape(snapshotDate)}, ${sqlEscape(runType)}, ${sqlEscape(slug)}, ` +
          `${sqlEscape(locationName)}, ${theaters.length}, 'success', NULL` +
        `);`
      );
    } else {
      statements.push(
        `INSERT INTO fetch_log (` +
          `snapshot_date, run_type, province_slug, location_name, theater_count, status, error_message` +
        `) VALUES (` +
          `${sqlEscape(snapshotDate)}, ${sqlEscape(runType)}, ${sqlEscape(slug)}, ` +
          `${sqlEscape(locationName || slug)}, 0, 'error', ${sqlEscape(error)}` +
        `);`
      );
    }
  }

  const sqlContent = statements.join('\n');

  if (isDryRun) {
    console.log(`\n🧪 DRY-RUN: Generated ${statements.length} SQL statement(s).`);
    console.log(`Sample statement:\n${statements.slice(0, 3).join('\n')}\n...`);
    console.log('\n✅ Dry run completed successfully.');
    return;
  }

  // Write SQL statements to a temporary file
  const tempFilePath = path.join(os.tmpdir(), `thecinema_batch_${Date.now()}.sql`);
  fs.writeFileSync(tempFilePath, sqlContent, 'utf-8');

  console.log(`\n💾 Executing ${statements.length} statements on D1 (${isLocal ? '--local' : '--remote'})...`);

  try {
    const targetFlag = isLocal ? '--local' : '--remote';
    execFileSync('npx', ['wrangler', 'd1', 'execute', dbName, targetFlag, `--file=${tempFilePath}`], {
      stdio: 'inherit',
      env: process.env,
    });
    console.log('\n🎉 D1 database successfully updated!');
  } catch (err) {
    console.error('\n❌ Error executing D1 statements via Wrangler:', err.message);
    process.exit(1);
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
