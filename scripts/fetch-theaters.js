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

// ============================================================================
// CONSTANTS
// ============================================================================

const CONCURRENCY_LIMIT = 5;
const UPSTREAM_TIMEOUT_MS = 15000;
const DEFAULT_DB_NAME = 'thecinema-db';

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

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Computes snapshot date and run type based on Philippine Standard Time (UTC+8).
 */
function getSnapshotContext(date = new Date()) {
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const snapshotDate = dateFormatter.format(date); // Format: YYYY-MM-DD

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
 * Executes async tasks over an array with bounded concurrency.
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
 * Parses CLI arguments and environment variables into runtime config.
 */
function parseCliArgs() {
  const args = process.argv.slice(2);
  return {
    isDryRun: args.includes('--dry-run') || process.env.DRY_RUN === 'true',
    isLocal: args.includes('--local') || process.env.USE_LOCAL_DB === 'true',
    dbName: process.env.D1_DATABASE_NAME || DEFAULT_DB_NAME,
  };
}

/**
 * Prints startup information banner.
 */
function logBanner(config, context) {
  console.log('='.repeat(60));
  console.log(`🎬 The Cinema — D1 Pipeline`);
  console.log(`📅 Snapshot Date (PHT): ${context.snapshotDate}`);
  console.log(`⏰ Current PHT Hour:     ${context.phtHour}:00`);
  console.log(`🔄 Run Type:             ${context.runType.toUpperCase()}`);
  console.log(`🎯 Target DB:            ${config.dbName} (${config.isLocal ? 'local' : 'remote'})`);
  console.log(`🧪 Mode:                 ${config.isDryRun ? 'DRY-RUN (no DB write)' : 'LIVE'}`);
  console.log(`📍 Total Locations:      ${PROVINCES.length}`);
  console.log('='.repeat(60));
}

/**
 * Prints summary of fetch results.
 */
function logFetchSummary(results, durationSec) {
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
}

// ============================================================================
// PHASE 1: FETCH
// ============================================================================

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
      const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

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
 * Fetches all provinces with bounded concurrency and logs progress.
 */
async function fetchAllProvinces(provinces, concurrency) {
  console.log(`\n⏳ Fetching data from API (concurrency: ${concurrency})...`);
  const startTime = Date.now();

  const results = await mapConcurrent(provinces, concurrency, async (slug) => {
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
  return { results, durationSec };
}

// ============================================================================
// PHASE 2: BUILD SQL
// ============================================================================

/**
 * Generates an INSERT statement for a single theater snapshot.
 */
function buildSnapshotInsert(snapshotDate, slug, locationName, theater) {
  const logo = theater.logo_url || theater.logo || theater.branch_logo || null;
  const buyTicket = theater.buy_ticket ? 1 : 0;
  const provinceDisplay = theater.province || locationName || slug;

  return (
    `INSERT INTO theater_snapshots (` +
    `snapshot_date, province_slug, theater_id, theater_type, slug, branch_id, name, ` +
    `address1, address2, city, logo_url, longitude, latitude, buy_ticket, mall_group_id, province` +
    `) VALUES (` +
    `${sqlEscape(snapshotDate)}, ${sqlEscape(slug)}, ${sqlEscape(theater.id)}, ${sqlEscape(theater.theater_type)}, ` +
    `${sqlEscape(theater.slug)}, ${sqlEscape(theater.branch_id)}, ${sqlEscape(theater.name)}, ${sqlEscape(theater.address1)}, ` +
    `${sqlEscape(theater.address2)}, ${sqlEscape(theater.city)}, ${sqlEscape(logo)}, ${sqlEscape(theater.longitude)}, ` +
    `${sqlEscape(theater.latitude)}, ${buyTicket}, ${sqlEscape(theater.mall_group_id)}, ${sqlEscape(provinceDisplay)}` +
    `);`
  );
}

/**
 * Generates an INSERT statement for a fetch log entry.
 */
function buildFetchLogInsert(snapshotDate, runType, result) {
  const { slug, success, locationName, theaters, error } = result;
  const status = success ? 'success' : 'error';
  const count = success ? (theaters ? theaters.length : 0) : 0;
  const errorVal = success ? null : error;
  const locName = locationName || slug;

  return (
    `INSERT INTO fetch_log (` +
    `snapshot_date, run_type, province_slug, location_name, theater_count, status, error_message` +
    `) VALUES (` +
    `${sqlEscape(snapshotDate)}, ${sqlEscape(runType)}, ${sqlEscape(slug)}, ` +
    `${sqlEscape(locName)}, ${count}, ${sqlEscape(status)}, ${sqlEscape(errorVal)}` +
    `);`
  );
}

/**
 * Builds the complete list of SQL statements for all results.
 */
function buildSqlStatements(results, snapshotDate, runType) {
  const statements = [];

  for (const result of results) {
    const { slug, success, locationName, theaters } = result;

    // For 'refresh' runs, clear existing snapshots for this date and province first
    if (runType === 'refresh') {
      statements.push(
        `DELETE FROM theater_snapshots WHERE snapshot_date = ${sqlEscape(snapshotDate)} AND province_slug = ${sqlEscape(slug)};`
      );
    }

    if (success) {
      for (const theater of theaters) {
        statements.push(buildSnapshotInsert(snapshotDate, slug, locationName, theater));
      }
    }

    statements.push(buildFetchLogInsert(snapshotDate, runType, result));
  }

  return statements;
}

// ============================================================================
// PHASE 3: PERSIST
// ============================================================================

/**
 * Writes SQL statements to a temp file and applies them to Cloudflare D1 via Wrangler.
 */
function persistToD1(sqlContent, dbName, isLocal) {
  const tempFilePath = path.join(os.tmpdir(), `thecinema_batch_${Date.now()}.sql`);
  fs.writeFileSync(tempFilePath, sqlContent, 'utf-8');

  const targetFlag = isLocal ? '--local' : '--remote';
  console.log(`\n💾 Executing statements on D1 (${targetFlag})...`);

  try {
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

// ============================================================================
// MAIN PIPELINE
// ============================================================================

async function main() {
  const config = parseCliArgs();
  const context = getSnapshotContext();
  logBanner(config, context);

  const { results, durationSec } = await fetchAllProvinces(PROVINCES, CONCURRENCY_LIMIT);
  logFetchSummary(results, durationSec);

  const hasSuccessful = results.some((r) => r.success);
  if (!hasSuccessful) {
    console.error('❌ All province fetches failed. Aborting database write.');
    process.exit(1);
  }

  const statements = buildSqlStatements(results, context.snapshotDate, context.runType);

  if (config.isDryRun) {
    console.log(`\n🧪 DRY-RUN: Generated ${statements.length} SQL statement(s).`);
    console.log(`Sample statement:\n${statements.slice(0, 3).join('\n')}\n...`);
    console.log('\n✅ Dry run completed successfully.');
    return;
  }

  persistToD1(statements.join('\n'), config.dbName, config.isLocal);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
