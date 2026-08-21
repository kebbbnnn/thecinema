/**
 * The Cinema — Movie Schedule Proxy Worker
 * Proxies upstream movie schedule API, caches at the edge,
 * and transforms responses into a movie-centric format.
 */

const CACHE_TTL_SECONDS = 3600; // 1 hour

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
 * Validates a date string is in YYYY-MM-DD format.
 */
function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr));
}

/**
 * Parses the URL path to extract the theater slug.
 * Expected: /api/theater/:slug
 */
function parseRoute(url) {
  const { pathname, searchParams } = new URL(url);
  const match = pathname.match(/^\/api\/theater\/([a-z0-9-]+)\/?$/);
  if (!match) return null;
  return {
    slug: match[1],
    date: searchParams.get('date') || getTodayPHT(),
  };
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
    movieMap.set(movie.movieId || movie.id, {
      id: movie.movieId || movie.id,
      title: movie.title,
      poster: movie.poster,
      mtrcb_rating: movie.mtrcb_rating,
      running_time: movie.running_time,
      in3d: movie.in3d || false,
      showtimes: [],
    });
  }

  // Group schedules by movieId
  for (const schedule of schedules) {
    let movie = movieMap.get(schedule.movieId);
    if (!movie) {
      // Movie in schedule but not in now_showing — create a stub
      movie = {
        id: schedule.movieId,
        title: 'Unknown',
        poster: null,
        mtrcb_rating: null,
        running_time: null,
        in3d: false,
        showtimes: [],
      };
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

/**
 * Returns a JSON response with CORS headers.
 */
function jsonResponse(data, status = 200, cacheControl = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // Parse route
    const route = parseRoute(request.url);
    if (!route) {
      return jsonResponse({ error: 'Not found. Use GET /api/theater/:slug?date=YYYY-MM-DD' }, 404);
    }

    const { slug, date } = route;

    // Validate date
    if (!isValidDate(date)) {
      return jsonResponse({ error: `Invalid date format: "${date}". Use YYYY-MM-DD.` }, 400);
    }

    // Check API_BASE_URL
    const apiBaseUrl = (env.API_BASE_URL || '').replace(/\/+$/, '');
    if (!apiBaseUrl) {
      return jsonResponse({ error: 'Server misconfiguration: API_BASE_URL not set.' }, 500);
    }

    // Build a canonical cache key URL
    const cacheKeyUrl = new URL(request.url);
    cacheKeyUrl.search = `?date=${date}`;
    const cacheKey = new Request(cacheKeyUrl.toString());

    // Check cache (if Cache API is available in environment)
    const cache = typeof caches !== 'undefined' && caches ? caches.default : null;
    if (cache) {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        // Clone and add cache hit header
        const headers = new Headers(cachedResponse.headers);
        headers.set('X-Cache', 'HIT');
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          headers,
        });
      }
    }

    // Fetch from upstream
    const upstreamUrl = `${apiBaseUrl}/movies/theater/${slug}?date=${date}`;
    let upstreamData;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const upstreamRes = await fetch(upstreamUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'TheCinema-Worker/1.0',
          Accept: 'application/json',
        },
      });
      clearTimeout(timeoutId);

      if (!upstreamRes.ok) {
        return jsonResponse(
          { error: `Upstream returned ${upstreamRes.status}` },
          502
        );
      }

      upstreamData = await upstreamRes.json();
    } catch (err) {
      return jsonResponse(
        { error: `Upstream fetch failed: ${err.message}` },
        502
      );
    }

    if (!upstreamData.status) {
      return jsonResponse(
        { error: 'Upstream returned unsuccessful response' },
        502
      );
    }

    // Transform response
    const transformed = transformResponse(upstreamData, date);

    // Build cacheable response
    const response = jsonResponse(transformed, 200, `public, max-age=${CACHE_TTL_SECONDS}`);
    response.headers.set('X-Cache', 'MISS');

    // Store in cache (if available)
    if (cache) {
      const responseToCache = response.clone();
      await cache.put(cacheKey, responseToCache);
    }

    return response;
  },
};
