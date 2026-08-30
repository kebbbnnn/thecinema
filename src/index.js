/**
 * The Cinema — Movie Schedule Proxy Worker
 * Proxies upstream movie schedule API, caches at the edge,
 * transforms responses into a movie-centric format, and manages
 * custom theater photography via ImageKit and Cloudflare D1.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const CACHE_TTL_SECONDS = 3600; // 1 hour (theaters & locations)
const MOVIE_CACHE_TTL_SECONDS = 86400; // 24 hours (edge cache for movie details)
const MOVIE_D1_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (D1 cache freshness)
const UPSTREAM_TIMEOUT_MS = 15000; // 15 seconds

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
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
 * Validates admin API authentication.
 */
function validateAdminAuth(request, env) {
  const configuredKey = env.ADMIN_API_KEY;
  if (!configuredKey) {
    return { ok: false, status: 500, error: 'Server misconfiguration: ADMIN_API_KEY not set.' };
  }

  const xAdminKey = request.headers.get('X-Admin-Key');
  const authHeader = request.headers.get('Authorization');
  const bearerKey = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  const providedKey = xAdminKey || bearerKey;
  if (!providedKey || providedKey !== configuredKey) {
    return { ok: false, status: 401, error: 'Unauthorized: Invalid or missing admin key.' };
  }

  return { ok: true };
}

/**
 * Uploads an image binary/file to ImageKit.io.
 */
async function uploadToImageKit(fileBlob, fileName, env) {
  const privateKey = env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) {
    return { ok: false, status: 500, error: 'Server misconfiguration: IMAGEKIT_PRIVATE_KEY not set.' };
  }

  const formData = new FormData();
  formData.append('file', fileBlob, fileName);
  formData.append('fileName', fileName);
  formData.append('folder', '/theaters');
  formData.append('useUniqueFileName', 'true');

  const authHeader = `Basic ${btoa(`${privateKey}:`)}`;

  try {
    const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
      },
      body: formData,
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { ok: false, status: 502, error: `ImageKit upload failed (${res.status}): ${errorText}` };
    }

    const json = await res.json();
    return {
      ok: true,
      data: {
        fileId: json.fileId,
        name: json.name,
        url: json.url,
        thumbnailUrl: json.thumbnailUrl || json.url,
      },
    };
  } catch (err) {
    return { ok: false, status: 502, error: `ImageKit upload request error: ${err.message}` };
  }
}

/**
 * Deletes an image file from ImageKit.io by file ID.
 */
async function deleteFromImageKit(fileId, env) {
  const privateKey = env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey || !fileId) return { ok: true };

  const authHeader = `Basic ${btoa(`${privateKey}:`)}`;
  try {
    const res = await fetch(`https://api.imagekit.io/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: {
        Authorization: authHeader,
      },
    });
    return { ok: res.ok || res.status === 404 };
  } catch {
    return { ok: false };
  }
}

/**
 * Safely deletes a file from ImageKit only if no other theater references it.
 */
async function safelyDeleteImageKitFile(fileId, currentSlug, env) {
  if (!fileId || !env.DB) return;

  try {
    const check = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM theater_custom_images WHERE file_id = ? AND slug != ?'
    ).bind(fileId, currentSlug).first();

    const isStillUsed = Number(check?.count || 0) > 0;
    if (!isStillUsed) {
      await deleteFromImageKit(fileId, env);
    }
  } catch (err) {
    console.error(`Error checking reference count for fileId ${fileId}:`, err);
  }
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
    image_url: row.custom_image_url || row.logo_url || null,
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
 * Normalizes raw upstream movie details into a standardized, clean schema.
 */
function normalizeMovieDetails(raw = {}) {
  const youtubeId = raw.youtube_trailer_url || null;
  let youtubeUrl = null;
  if (youtubeId) {
    youtubeUrl = youtubeId.startsWith('http')
      ? youtubeId
      : `https://www.youtube.com/watch?v=${youtubeId}`;
  }

  const genres = (raw.genre_list || []).map((g) => ({
    id: g.genre_id || null,
    slug: g.slug || null,
    name: g.name || null,
  }));

  const credits = (raw.person_assoc || []).map((category) => ({
    category: category.name || 'Other',
    members: (category.assoc || []).map((person) => ({
      id: person.person_id || null,
      hash: person.hash || null,
      slug: person.slug || null,
      name: person.name || `${person.first_name || ''}${person.last_name || ''}`.trim() || null,
      role: person.role || null,
      image_url: person.image_url || null,
    })),
  }));

  const userRating = raw.user_rating || {};
  const userAverage = parseFloat(userRating.average) || 0.0;
  const userTotal = parseInt(userRating.total, 10) || 0;

  return {
    id: raw.movie_id || null,
    hash: raw.hash || null,
    slug: raw.slug || null,
    title: raw.title || 'Unknown',
    synopsis: raw.synopsis || null,
    runtime: raw.running_time || null,
    release_date: raw.release_date || null,
    year_released: raw.year_released || null,
    opening_date: raw.opening_date || null,
    country: raw.country || null,
    released_by: raw.released_by || null,
    mtrcb_rating: raw.mtrcb_rating || null,
    now_showing: raw.now_showing === true || raw.now_showing === 1,
    buy_ticket: raw.buy_ticket === true || raw.buy_ticket === 1,
    posters: {
      small: raw.poster || null,
      large: raw.poster_url || raw.poster_large || null,
    },
    trailers: {
      youtube_id: youtubeId,
      youtube_url: youtubeUrl,
      imdb_url: raw.imdb_url || null,
      website_url: raw.website || null,
    },
    genres,
    credits,
    ratings: {
      user_average: userAverage,
      user_total: userTotal,
    },
  };
}

/**
 * Fetches full movie details from the upstream API.
 * Returns { ok: true, data } or { ok: false, error, status }.
 */
async function fetchUpstreamMovieDetails(apiBaseUrl, hash) {
  const upstreamUrl = `${apiBaseUrl}/movies/${hash}`;

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
        status: upstreamRes.status === 404 ? 404 : 502,
        error: `Upstream returned ${upstreamRes.status}`,
      };
    }

    const json = await upstreamRes.json();
    if (!json || json.status === false || !json.data) {
      return {
        ok: false,
        status: 404,
        error: json?.message || 'Movie not found upstream',
      };
    }

    return { ok: true, data: json.data };
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
      image_url: null,
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

  // Transform response
  const transformed = transformResponse(upstream.data, date);

  // Check D1 for custom image override
  if (env.DB && transformed.theater) {
    try {
      const customImg = await env.DB.prepare(
        'SELECT image_url FROM theater_custom_images WHERE slug = ?'
      ).bind(slug).first();
      if (customImg && customImg.image_url) {
        transformed.theater.image_url = customImg.image_url;
      }
    } catch (err) {
      console.error(`Error querying custom image for theater ${slug}:`, err);
    }
  }

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
        t.snapshot_date, t.province, t.theater_id, t.theater_type, t.slug, t.branch_id,
        t.name, t.address1, t.address2, t.city, t.logo_url, t.latitude, t.longitude,
        t.buy_ticket, t.mall_group_id,
        c.image_url AS custom_image_url
      FROM theater_snapshots t
      LEFT JOIN theater_custom_images c ON t.slug = c.slug
      WHERE t.province_slug = ?
        AND t.snapshot_date = (
          SELECT MAX(snapshot_date)
          FROM theater_snapshots
          WHERE province_slug = ?
        )
      ORDER BY t.name ASC;
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

/**
 * Handler for GET /api/movies/:hash
 * Returns full movie details with two-tier caching (Edge Cache + D1 persistent cache).
 */
async function handleMovieDetails(request, env, params) {
  const hash = params[0];

  // Canonical cache key
  const cacheKey = new Request(request.url);

  // 1. Check Edge Cache if available
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

  let d1Record = null;
  let isD1Fresh = false;

  // 2. Check D1 Persistent Cache if available
  if (env.DB) {
    try {
      const query = `
        SELECT data_json, updated_at
        FROM movie_cache
        WHERE hash = ?;
      `;
      const result = await env.DB.prepare(query).bind(hash).first();
      if (result && result.data_json) {
        d1Record = result;
        const updatedAtTime = result.updated_at ? new Date(result.updated_at).getTime() : 0;
        const now = Date.now();
        if (now - updatedAtTime <= MOVIE_D1_TTL_MS) {
          isD1Fresh = true;
        }
      }
    } catch (err) {
      console.error(`D1 lookup error for hash ${hash}:`, err);
    }
  }

  // If D1 record is fresh (< 7 days), serve directly and backfill edge cache
  if (d1Record && isD1Fresh) {
    try {
      const parsedData = JSON.parse(d1Record.data_json);
      const response = jsonResponse(parsedData, 200, `public, max-age=${MOVIE_CACHE_TTL_SECONDS}`);
      response.headers.set('X-Cache', 'HIT-D1');

      if (cache) {
        await cache.put(cacheKey, response.clone());
      }
      return response;
    } catch {
      // Corrupt data_json in D1, proceed to upstream fetch
    }
  }

  // 3. Upstream Fetch
  const apiBaseUrl = (env.API_BASE_URL || '').replace(/\/+$/, '');
  if (!apiBaseUrl) {
    if (d1Record) {
      try {
        const parsedData = JSON.parse(d1Record.data_json);
        const response = jsonResponse(parsedData, 200, `public, max-age=${MOVIE_CACHE_TTL_SECONDS}`);
        response.headers.set('X-Cache', 'STALE-D1');
        response.headers.set('Warning', '110 - "Response is Stale"');
        return response;
      } catch {
        // fall through
      }
    }
    return jsonResponse({ error: 'Server misconfiguration: API_BASE_URL not set.' }, 500);
  }

  const upstream = await fetchUpstreamMovieDetails(apiBaseUrl, hash);

  if (upstream.ok) {
    const normalized = normalizeMovieDetails(upstream.data);
    const dataJson = JSON.stringify(normalized);

    // Persist to D1
    if (env.DB) {
      try {
        const upsertQuery = `
          INSERT INTO movie_cache (hash, movie_id, slug, title, data_json, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(hash) DO UPDATE SET
            movie_id = excluded.movie_id,
            slug = excluded.slug,
            title = excluded.title,
            data_json = excluded.data_json,
            updated_at = datetime('now');
        `;
        await env.DB.prepare(upsertQuery)
          .bind(hash, normalized.id, normalized.slug, normalized.title, dataJson)
          .run();
      } catch (err) {
        console.error(`D1 upsert error for hash ${hash}:`, err);
      }
    }

    const response = jsonResponse(normalized, 200, `public, max-age=${MOVIE_CACHE_TTL_SECONDS}`);
    response.headers.set('X-Cache', 'MISS');

    if (cache) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  }

  // 4. Upstream Failed — Check if we have a stale D1 record as resilient fallback
  if (d1Record) {
    try {
      const parsedData = JSON.parse(d1Record.data_json);
      const response = jsonResponse(parsedData, 200, `public, max-age=${MOVIE_CACHE_TTL_SECONDS}`);
      response.headers.set('X-Cache', 'STALE-D1');
      response.headers.set('Warning', '110 - "Response is Stale"');
      return response;
    } catch {
      // fall through
    }
  }

  // 5. No fallback available, return upstream error
  return jsonResponse({ error: upstream.error }, upstream.status);
}

// ============================================================================
// ADMIN ROUTE HANDLERS
// ============================================================================

/**
 * Handler for GET /api/admin/theaters
 * Lists all theaters from the latest snapshot combined with custom image status.
 */
async function handleAdminListTheaters(request, env) {
  const auth = validateAdminAuth(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }

  if (!env.DB) {
    return jsonResponse({ error: 'Database binding DB is not configured.' }, 500);
  }

  try {
    const query = `
      SELECT 
        s.theater_id,
        s.slug,
        s.name,
        s.province,
        s.province_slug,
        s.city,
        s.logo_url,
        c.image_url AS custom_image_url,
        c.file_id,
        c.thumbnail_url,
        c.updated_at AS custom_image_updated_at
      FROM theater_snapshots s
      LEFT JOIN theater_custom_images c ON s.slug = c.slug
      WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM theater_snapshots)
      ORDER BY s.province ASC, s.name ASC;
    `;

    const { results } = await env.DB.prepare(query).all();
    const rows = results || [];

    const theaters = rows.map((r) => ({
      theater_id: r.theater_id,
      slug: r.slug,
      name: r.name,
      province: r.province,
      province_slug: r.province_slug,
      city: r.city,
      logo_url: r.logo_url,
      has_custom_image: Boolean(r.custom_image_url),
      custom_image_url: r.custom_image_url || null,
      file_id: r.file_id || null,
      thumbnail_url: r.thumbnail_url || null,
      updated_at: r.custom_image_updated_at || null,
    }));

    const total = theaters.length;
    const withCustomImage = theaters.filter((t) => t.has_custom_image).length;
    const missingImage = total - withCustomImage;

    return jsonResponse({
      total,
      with_custom_image: withCustomImage,
      missing_image: missingImage,
      theaters,
    });
  } catch (err) {
    return jsonResponse({ error: `Failed to query admin theaters: ${err.message}` }, 500);
  }
}

/**
 * Handler for POST /api/admin/theaters/:slug/image
 * Uploads a fresh image to ImageKit OR links an existing ImageKit asset, and upserts D1.
 */
async function handleAdminUploadTheaterImage(request, env, params) {
  const auth = validateAdminAuth(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }

  if (!env.DB) {
    return jsonResponse({ error: 'Database binding DB is not configured.' }, 500);
  }

  const slug = params[0];
  if (!slug) {
    return jsonResponse({ error: 'Theater slug is required.' }, 400);
  }

  try {
    const contentType = request.headers.get('content-type') || '';

    // Check if there is an existing custom image file_id to replace
    let oldFileId = null;
    try {
      const existing = await env.DB.prepare(
        'SELECT file_id FROM theater_custom_images WHERE slug = ?'
      ).bind(slug).first();
      if (existing) {
        oldFileId = existing.file_id;
      }
    } catch {
      // ignore
    }

    let url, fileId, thumbnailUrl, theaterId, name;

    // CASE 1: JSON payload (linking an existing asset from the media library)
    if (contentType.includes('application/json')) {
      const body = await request.json();
      url = body.image_url;
      fileId = body.file_id || null;
      thumbnailUrl = body.thumbnail_url || url;
      theaterId = body.theater_id ? parseInt(body.theater_id, 10) : null;
      name = body.name || slug;

      if (!url) {
        return jsonResponse({ error: 'Missing image_url in JSON payload.' }, 400);
      }
    }
    // CASE 2: Multipart form-data (fresh file upload)
    else if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      theaterId = formData.get('theater_id') ? parseInt(formData.get('theater_id'), 10) : null;
      name = formData.get('name') || slug;

      if (!file || typeof file === 'string') {
        return jsonResponse({ error: 'Missing image file.' }, 400);
      }

      // Validate MIME type
      const validMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      if (file.type && !validMimes.includes(file.type.toLowerCase())) {
        return jsonResponse({ error: `Unsupported file type: ${file.type}. Allowed: JPEG, PNG, WebP.` }, 400);
      }

      // Validate file size (max 5MB)
      const MAX_FILE_SIZE = 5 * 1024 * 1024;
      if (file.size && file.size > MAX_FILE_SIZE) {
        return jsonResponse({ error: 'File size exceeds 5MB limit.' }, 400);
      }

      // Upload to ImageKit
      const fileName = `${slug}-${Date.now()}`;
      const uploadResult = await uploadToImageKit(file, fileName, env);
      if (!uploadResult.ok) {
        return jsonResponse({ error: uploadResult.error }, uploadResult.status || 502);
      }

      url = uploadResult.data.url;
      fileId = uploadResult.data.fileId;
      thumbnailUrl = uploadResult.data.thumbnailUrl;
    } else {
      return jsonResponse(
        { error: 'Content-Type must be multipart/form-data or application/json.' },
        400
      );
    }

    // Upsert into D1
    const upsertQuery = `
      INSERT INTO theater_custom_images (slug, theater_id, name, image_url, file_id, thumbnail_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        theater_id = COALESCE(excluded.theater_id, theater_custom_images.theater_id),
        name = COALESCE(excluded.name, theater_custom_images.name),
        image_url = excluded.image_url,
        file_id = excluded.file_id,
        thumbnail_url = excluded.thumbnail_url,
        updated_at = datetime('now');
    `;

    await env.DB.prepare(upsertQuery)
      .bind(slug, theaterId, name, url, fileId, thumbnailUrl)
      .run();

    // Safely clean up old file if different and not shared by other theaters
    if (oldFileId && oldFileId !== fileId) {
      safelyDeleteImageKitFile(oldFileId, slug, env).catch(() => {});
    }

    return jsonResponse({
      success: true,
      message: 'Theater image saved successfully.',
      data: {
        slug,
        theater_id: theaterId,
        name,
        image_url: url,
        file_id: fileId,
        thumbnail_url: thumbnailUrl,
      },
    });
  } catch (err) {
    return jsonResponse({ error: `Upload/link handler error: ${err.message}` }, 500);
  }
}

/**
 * Handler for DELETE /api/admin/theaters/:slug/image
 * Deletes custom theater image from D1 and safely cleans up ImageKit file if unreferenced.
 */
async function handleAdminDeleteTheaterImage(request, env, params) {
  const auth = validateAdminAuth(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }

  if (!env.DB) {
    return jsonResponse({ error: 'Database binding DB is not configured.' }, 500);
  }

  const slug = params[0];
  if (!slug) {
    return jsonResponse({ error: 'Theater slug is required.' }, 400);
  }

  try {
    const existing = await env.DB.prepare(
      'SELECT file_id FROM theater_custom_images WHERE slug = ?'
    ).bind(slug).first();

    if (!existing) {
      return jsonResponse({ error: `No custom image found for theater "${slug}".` }, 404);
    }

    // Safely delete from ImageKit only if no other theater references this asset
    if (existing.file_id) {
      await safelyDeleteImageKitFile(existing.file_id, slug, env);
    }

    await env.DB.prepare('DELETE FROM theater_custom_images WHERE slug = ?').bind(slug).run();

    return jsonResponse({
      success: true,
      message: `Custom image for theater "${slug}" deleted successfully.`,
    });
  } catch (err) {
    return jsonResponse({ error: `Delete handler error: ${err.message}` }, 500);
  }
}

// ============================================================================
// ROUTER
// ============================================================================

const ROUTES = [
  {
    pattern: /^\/api\/admin\/theaters\/([a-z0-9-]+)\/image\/?$/,
    methods: {
      POST: handleAdminUploadTheaterImage,
      DELETE: handleAdminDeleteTheaterImage,
    },
  },
  {
    pattern: /^\/api\/admin\/theaters\/?$/,
    methods: {
      GET: handleAdminListTheaters,
    },
  },
  {
    pattern: /^\/api\/locations\/([a-z0-9-]+)\/?$/,
    methods: {
      GET: handleLocationTheaters,
    },
  },
  {
    pattern: /^\/api\/locations\/?$/,
    methods: {
      GET: handleLocations,
    },
  },
  {
    pattern: /^\/api\/theater\/([a-z0-9-]+)\/?$/,
    methods: {
      GET: handleTheaterSchedule,
    },
  },
  {
    pattern: /^\/api\/movies\/([a-zA-Z0-9_-]+)\/?$/,
    methods: {
      GET: handleMovieDetails,
    },
  },
];

// ============================================================================
// ENTRY POINT
// ============================================================================

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    const { pathname, searchParams } = new URL(request.url);

    for (const route of ROUTES) {
      const match = pathname.match(route.pattern);
      if (match) {
        const handler = route.methods[request.method];
        if (!handler) {
          return jsonResponse({ error: `Method ${request.method} not allowed for ${pathname}` }, 405);
        }
        const params = match.slice(1);
        return handler(request, env, params, searchParams);
      }
    }

    return jsonResponse(
      {
        error:
          'Not found. Available endpoints: GET /api/locations, GET /api/locations/:slug, GET /api/theater/:slug?date=YYYY-MM-DD, GET /api/movies/:hash, GET /api/admin/theaters, POST /api/admin/theaters/:slug/image, DELETE /api/admin/theaters/:slug/image',
      },
      404
    );
  },
};
