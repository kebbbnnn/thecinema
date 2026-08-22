/**
 * The Cinema — Movie Schedule Proxy Worker
 * Proxies upstream movie schedule API, caches at the edge,
 * and transforms responses into a movie-centric format.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const CACHE_TTL_SECONDS = 3600; // 1 hour
const UPSTREAM_TIMEOUT_MS = 15000; // 15 seconds

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const METRO_MANILA_SLUGS = new Set([
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
]);

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Returns today's date in Philippine Time (UTC+8) as YYYY-MM-DD.
 */
function getTodayPHT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Validates whether a date string conforms to YYYY-MM-DD format and is valid.
 */
function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr));
}

/**
 * Constructs a standardized JSON response with CORS headers.
 */
function jsonResponse(data, status = 200, cacheControl = null) {
  const headers = {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
  };
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Returns a 204 No Content response for CORS preflight OPTIONS requests.
 */
function corsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/**
 * Normalizes movie data into a standard movie object with an empty showtimes array.
 */
function createMovieEntry(movie = {}) {
  return {
    id: movie.movieId || movie.id || null,
    title: movie.title || 'Unknown',
    poster: movie.poster || null,
    mtrcb_rating: movie.mtrcb_rating || null,
    running_time: movie.running_time || null,
    in3d: movie.in3d || false,
    showtimes: [],
  };
}

/**
 * Formats a raw database row from theater_snapshots into a standardized API theater object.
 */
function formatTheaterSnapshot(row) {
  return {
    id: row.theater_id || row.id || null,
    name: row.name,
    slug: row.slug,
    theater_type: row.theater_type || null,
    branch_id: row.branch_id || null,
    city: row.city || null,
    address1: row.address1 || null,
    address2: row.address2 || null,
    logo_url: row.logo_url || null,
    latitude: row.latitude || null,
    longitude: row.longitude || null,
    buy_ticket: row.buy_ticket === 1 || row.buy_ticket === true,
    mall_group_id: row.mall_group_id || null,
  };
}

// ============================================================================
// SERVICES & TRANSFORMS
// ============================================================================

/**
 * Fetches movie schedule data from the upstream API.
 * Returns { ok: true, data } or { ok: false, error, status }.
 */
async function fetchUpstreamSchedule(apiBaseUrl, slug, date) {
  const upstreamUrl = `${apiBaseUrl}/movies/theater/${slug}?date=${date}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const upstreamRes = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TheCinema-Worker/1.0',
        Accept: 'application/json',
      },
    });
    clearTimeout(timeoutId);

    if (!upstreamRes.ok) {
      return {
        ok: false,
        status: 502,
        error: `Upstream returned ${upstreamRes.status}`,
      };
    }

    const data = await upstreamRes.json();
    if (!data || !data.status) {
      return {
        ok: false,
        status: 502,
        error: 'Upstream returned unsuccessful response',
      };
    }

    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Upstream fetch failed: ${err.message}`,
    };
  }
}

/**
 * Transforms the upstream API response into a movie-centric format.
 */
function transformResponse(data, requestedDate) {
  const theater = data.theater || {};
  const nowShowing = data.now_showing || [];
  const schedules = data.schedules || [];
  const availableSchedule = theater.available_schedule || [];

  // Build a lookup of movie metadata by movieId
  const movieMap = new Map();
  for (const movie of nowShowing) {
    const entry = createMovieEntry(movie);
    movieMap.set(entry.id, entry);
  }

  // Group schedules by movieId
  for (const schedule of schedules) {
    let movie = movieMap.get(schedule.movieId);
    if (!movie) {
      // Movie in schedule but not in now_showing — create a fallback entry
      movie = createMovieEntry({ movieId: schedule.movieId });
      movieMap.set(schedule.movieId, movie);
    }
    movie.showtimes.push({
      screen: schedule.theaterName,
      screen_slug: schedule.theaterSlug,
      times: schedule.showtimes || [],
    });
  }

  return {
    theater: {
      id: theater.id,
      name: theater.name,
      slug: theater.slug,
      city: theater.city,
      address: theater.address,
      latitude: theater.latitude,
      longitude: theater.longitude,
      screens: theater.screens,
    },
    date: requestedDate,
    available_schedule: availableSchedule,
    movies: Array.from(movieMap.values()),
  };
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Handler for GET /api/theater/:slug?date=YYYY-MM-DD
 */
async function handleTheaterSchedule(request, env, params, searchParams) {
  const slug = params[0];
  const date = searchParams.get('date') || getTodayPHT();

  // Validate date parameter
  if (!isValidDate(date)) {
    return jsonResponse({ error: `Invalid date format: "${date}". Use YYYY-MM-DD.` }, 400);
  }

  // Check configuration
  const apiBaseUrl = (env.API_BASE_URL || '').replace(/\/+$/, '');
  if (!apiBaseUrl) {
    return jsonResponse({ error: 'Server misconfiguration: API_BASE_URL not set.' }, 500);
  }

  // Canonical cache key
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.search = `?date=${date}`;
  const cacheKey = new Request(cacheKeyUrl.toString());

  // Check edge cache if available
  const cache = typeof caches !== 'undefined' && caches ? caches.default : null;
  if (cache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const headers = new Headers(cachedResponse.headers);
      headers.set('X-Cache', 'HIT');
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    }
  }

  // Fetch upstream schedule
  const upstream = await fetchUpstreamSchedule(apiBaseUrl, slug, date);
  if (!upstream.ok) {
    return jsonResponse({ error: upstream.error }, upstream.status);
  }

  // Transform and build cacheable response
  const transformed = transformResponse(upstream.data, date);
  const response = jsonResponse(transformed, 200, `public, max-age=${CACHE_TTL_SECONDS}`);
  response.headers.set('X-Cache', 'MISS');

  // Store in edge cache
  if (cache) {
    await cache.put(cacheKey, response.clone());
  }

  return response;
}

/**
 * Handler for GET /api/locations
 * Returns provinces and Metro Manila cities that have theaters in the latest snapshot.
 */
async function handleLocations(request, env) {
  if (!env.DB) {
    return jsonResponse({ error: 'Database binding DB is not configured.' }, 500);
  }

  // Canonical cache key
  const cacheKey = new Request(request.url);

  // Check edge cache if available
  const cache = typeof caches !== 'undefined' && caches ? caches.default : null;
  if (cache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const headers = new Headers(cachedResponse.headers);
      headers.set('X-Cache', 'HIT');
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    }
  }

  try {
    const query = `
      SELECT snapshot_date, province_slug, province AS name, COUNT(*) AS theater_count
      FROM theater_snapshots
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM theater_snapshots)
      GROUP BY snapshot_date, province_slug, province
      ORDER BY name ASC;
    `;

    const { results } = await env.DB.prepare(query).all();
    const rows = results || [];

    let snapshotDate = null;
    const provinces = [];
    const metroManila = [];

    for (const row of rows) {
      if (!snapshotDate && row.snapshot_date) {
        snapshotDate = row.snapshot_date;
      }

      const item = {
        slug: row.province_slug,
        name: row.name || row.province_slug,
        theater_count: Number(row.theater_count) || 0,
      };

      if (METRO_MANILA_SLUGS.has(row.province_slug)) {
        metroManila.push(item);
      } else {
        provinces.push(item);
      }
    }

    const payload = {
      snapshot_date: snapshotDate,
      provinces,
      metro_manila: metroManila,
    };

    const response = jsonResponse(payload, 200, `public, max-age=${CACHE_TTL_SECONDS}`);
    response.headers.set('X-Cache', 'MISS');

    if (cache) {
      await cache.put(cacheKey, response.clone());
    }

    return response;
  } catch (err) {
    return jsonResponse({ error: `Failed to query locations: ${err.message}` }, 500);
  }
}

/**
 * Handler for GET /api/locations/:slug
 * Returns all theaters in a given province or Metro Manila city for the latest snapshot.
 */
async function handleLocationTheaters(request, env, params) {
  const slug = params[0];

  if (!env.DB) {
    return jsonResponse({ error: 'Database binding DB is not configured.' }, 500);
  }

  // Canonical cache key
  const cacheKey = new Request(request.url);

  // Check edge cache if available
  const cache = typeof caches !== 'undefined' && caches ? caches.default : null;
  if (cache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const headers = new Headers(cachedResponse.headers);
      headers.set('X-Cache', 'HIT');
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    }
  }

  try {
    const query = `
      SELECT 
        snapshot_date, province, theater_id, theater_type, slug, branch_id,
        name, address1, address2, city, logo_url, latitude, longitude,
        buy_ticket, mall_group_id
      FROM theater_snapshots
      WHERE province_slug = ?
        AND snapshot_date = (
          SELECT MAX(snapshot_date)
          FROM theater_snapshots
          WHERE province_slug = ?
        )
      ORDER BY name ASC;
    `;

    const { results } = await env.DB.prepare(query).bind(slug, slug).all();
    const rows = results || [];

    if (rows.length === 0) {
      return jsonResponse(
        { error: `Location "${slug}" not found or has no theater records.` },
        404
      );
    }

    const snapshotDate = rows[0].snapshot_date;
    const locationName = rows[0].province || slug;
    const theaters = rows.map(formatTheaterSnapshot);

    const payload = {
      location: {
        slug,
        name: locationName,
      },
      snapshot_date: snapshotDate,
      total_theaters: theaters.length,
      theaters,
    };

    const response = jsonResponse(payload, 200, `public, max-age=${CACHE_TTL_SECONDS}`);
    response.headers.set('X-Cache', 'MISS');

    if (cache) {
      await cache.put(cacheKey, response.clone());
    }

    return response;
  } catch (err) {
    return jsonResponse({ error: `Failed to query theaters for location: ${err.message}` }, 500);
  }
}

// ============================================================================
// ROUTER
// ============================================================================

const ROUTES = [
  {
    pattern: /^\/api\/locations\/([a-z0-9-]+)\/?$/,
    handler: handleLocationTheaters,
  },
  {
    pattern: /^\/api\/locations\/?$/,
    handler: handleLocations,
  },
  {
    pattern: /^\/api\/theater\/([a-z0-9-]+)\/?$/,
    handler: handleTheaterSchedule,
  },
];

/**
 * Matches a pathname against configured routes.
 */
function matchRoute(pathname) {
  for (const route of ROUTES) {
    const match = pathname.match(route.pattern);
    if (match) {
      return {
        handler: route.handler,
        params: match.slice(1),
      };
    }
  }
  return null;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const { pathname, searchParams } = new URL(request.url);
    const matched = matchRoute(pathname);

    if (!matched) {
      return jsonResponse(
        { error: 'Not found. Available endpoints: GET /api/locations, GET /api/locations/:slug, GET /api/theater/:slug?date=YYYY-MM-DD' },
        404
      );
    }

    return matched.handler(request, env, matched.params, searchParams);
  },
};
