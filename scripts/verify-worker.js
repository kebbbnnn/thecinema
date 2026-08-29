import assert from 'node:assert/strict';
import worker from '../src/index.js';

async function testWorker() {
  console.log('Testing Worker...');

  // 1. CORS Preflight
  const optionsRes = await worker.fetch(new Request('http://localhost/api/theater/cebu', { method: 'OPTIONS' }), {});
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get('Access-Control-Allow-Origin'), '*');
  console.log('✓ OPTIONS CORS preflight returns 204');

  // 2. Non-GET method
  const postRes = await worker.fetch(new Request('http://localhost/api/theater/cebu', { method: 'POST' }), {});
  assert.equal(postRes.status, 405);
  console.log('✓ Non-GET method returns 405');

  // 3. Unknown route
  const notFoundRes = await worker.fetch(new Request('http://localhost/api/unknown', { method: 'GET' }), {});
  assert.equal(notFoundRes.status, 404);
  console.log('✓ Unknown route returns 404');

  // 4. Invalid date format
  const invalidDateRes = await worker.fetch(
    new Request('http://localhost/api/theater/cebu?date=invalid-date', { method: 'GET' }),
    {}
  );
  assert.equal(invalidDateRes.status, 400);
  const invalidDateBody = await invalidDateRes.json();
  assert.match(invalidDateBody.error, /Invalid date format/);
  console.log('✓ Invalid date returns 400');

  // 5. Missing API_BASE_URL
  const missingEnvRes = await worker.fetch(
    new Request('http://localhost/api/theater/cebu?date=2026-08-21', { method: 'GET' }),
    {}
  );
  assert.equal(missingEnvRes.status, 500);
  console.log('✓ Missing API_BASE_URL returns 500');

  // 6. Upstream fetch transformation
  const mockTheater = {
    id: 123,
    name: 'Test Theater',
    slug: 'test-theater',
    city: 'Cebu City',
    address: '123 Main St',
    latitude: '10.3',
    longitude: '123.9',
    screens: 2,
    available_schedule: ['2026-08-21'],
  };
  const mockNowShowing = [
    {
      movieId: 999,
      title: 'Inception',
      poster: 'http://img.test/poster.jpg',
      mtrcb_rating: 'PG-13',
      running_time: '2 hr 28 min',
      in3d: false,
    },
  ];
  const mockSchedules = [
    {
      movieId: 999,
      theaterName: 'Cinema 1',
      theaterSlug: 'test-cinema-1',
      showtimes: ['1:00 PM', '4:00 PM'],
    },
  ];

  // Mock global fetch for upstream testing
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return new Response(
      JSON.stringify({
        status: true,
        theater: mockTheater,
        now_showing: mockNowShowing,
        schedules: mockSchedules,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const successRes = await worker.fetch(
      new Request('http://localhost/api/theater/test-theater?date=2026-08-21', { method: 'GET' }),
      { API_BASE_URL: 'https://api.mock.test' }
    );
    assert.equal(successRes.status, 200);
    assert.equal(successRes.headers.get('X-Cache'), 'MISS');
    const data = await successRes.json();
    assert.equal(data.theater.name, 'Test Theater');
    assert.equal(data.date, '2026-08-21');
    assert.equal(data.movies.length, 1);
    assert.equal(data.movies[0].title, 'Inception');
    assert.equal(data.movies[0].showtimes[0].screen, 'Cinema 1');
    console.log('✓ Successful upstream fetch transforms and returns 200 OK');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 7. Locations endpoint: Missing env.DB
  const missingDbRes = await worker.fetch(
    new Request('http://localhost/api/locations', { method: 'GET' }),
    {}
  );
  assert.equal(missingDbRes.status, 500);
  const missingDbBody = await missingDbRes.json();
  assert.match(missingDbBody.error, /Database binding DB is not configured/);
  console.log('✓ GET /api/locations without DB binding returns 500');

  // 8. Locations endpoint: Empty database
  const mockEmptyDb = {
    prepare(query) {
      return {
        async all() {
          return { results: [] };
        },
      };
    },
  };
  const emptyDbRes = await worker.fetch(
    new Request('http://localhost/api/locations', { method: 'GET' }),
    { DB: mockEmptyDb }
  );
  assert.equal(emptyDbRes.status, 200);
  const emptyDbData = await emptyDbRes.json();
  assert.equal(emptyDbData.snapshot_date, null);
  assert.deepEqual(emptyDbData.provinces, []);
  assert.deepEqual(emptyDbData.metro_manila, []);
  console.log('✓ GET /api/locations on empty DB returns empty lists and null date');

  // 9. Locations endpoint: Populated database
  const mockRows = [
    { snapshot_date: '2026-08-17', province_slug: 'cebu', name: 'Cebu', theater_count: 8 },
    { snapshot_date: '2026-08-17', province_slug: 'makati', name: 'Makati', theater_count: 6 },
    { snapshot_date: '2026-08-17', province_slug: 'pampanga', name: 'Pampanga', theater_count: 5 },
    { snapshot_date: '2026-08-17', province_slug: 'quezon-city', name: 'Quezon City', theater_count: 14 },
  ];
  const mockPopulatedDb = {
    prepare(query) {
      assert.match(query, /MAX\(snapshot_date\)/);
      return {
        async all() {
          return { results: mockRows };
        },
      };
    },
  };
  const locationsRes = await worker.fetch(
    new Request('http://localhost/api/locations', { method: 'GET' }),
    { DB: mockPopulatedDb }
  );
  assert.equal(locationsRes.status, 200);
  assert.equal(locationsRes.headers.get('X-Cache'), 'MISS');
  const locationsData = await locationsRes.json();
  assert.equal(locationsData.snapshot_date, '2026-08-17');

  assert.equal(locationsData.provinces.length, 2);
  assert.deepEqual(locationsData.provinces[0], { slug: 'cebu', name: 'Cebu', theater_count: 8 });
  assert.deepEqual(locationsData.provinces[1], { slug: 'pampanga', name: 'Pampanga', theater_count: 5 });

  assert.equal(locationsData.metro_manila.length, 2);
  assert.deepEqual(locationsData.metro_manila[0], { slug: 'makati', name: 'Makati', theater_count: 6 });
  assert.deepEqual(locationsData.metro_manila[1], { slug: 'quezon-city', name: 'Quezon City', theater_count: 14 });
  console.log('✓ GET /api/locations groups provinces and Metro Manila cities accurately with theater counts');

  // 10. Location theaters endpoint: Missing env.DB
  const missingLocationDbRes = await worker.fetch(
    new Request('http://localhost/api/locations/cebu', { method: 'GET' }),
    {}
  );
  assert.equal(missingLocationDbRes.status, 500);
  const missingLocationDbBody = await missingLocationDbRes.json();
  assert.match(missingLocationDbBody.error, /Database binding DB is not configured/);
  console.log('✓ GET /api/locations/:slug without DB binding returns 500');

  // 11. Location theaters endpoint: Not found
  const notFoundLocationDb = {
    prepare(query) {
      return {
        bind(s1, s2) {
          assert.equal(s1, 'non-existent');
          assert.equal(s2, 'non-existent');
          return {
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
  const notFoundLocationRes = await worker.fetch(
    new Request('http://localhost/api/locations/non-existent', { method: 'GET' }),
    { DB: notFoundLocationDb }
  );
  assert.equal(notFoundLocationRes.status, 404);
  const notFoundLocationBody = await notFoundLocationRes.json();
  assert.match(notFoundLocationBody.error, /Location "non-existent" not found/);
  console.log('✓ GET /api/locations/:slug on non-existent location returns 404');

  // 12. Location theaters endpoint: Success
  const mockTheaterRows = [
    {
      snapshot_date: '2026-08-17',
      province: 'Cebu',
      theater_id: 75,
      theater_type: 'TM',
      slug: 'ayala-center-cebu',
      branch_id: '7401',
      name: 'Ayala Center Cebu',
      address1: 'Cebu Business Park',
      address2: null,
      city: 'Cebu City',
      logo_url: 'https://img.test/ayala.png',
      latitude: '10.3173',
      longitude: '123.9048',
      buy_ticket: 1,
      mall_group_id: 'ayala',
    },
  ];
  const mockLocationTheatersDb = {
    prepare(query) {
      assert.match(query, /province_slug = \?/);
      return {
        bind(s1, s2) {
          assert.equal(s1, 'cebu');
          assert.equal(s2, 'cebu');
          return {
            async all() {
              return { results: mockTheaterRows };
            },
          };
        },
      };
    },
  };
  const locationTheatersRes = await worker.fetch(
    new Request('http://localhost/api/locations/cebu', { method: 'GET' }),
    { DB: mockLocationTheatersDb }
  );
  assert.equal(locationTheatersRes.status, 200);
  assert.equal(locationTheatersRes.headers.get('X-Cache'), 'MISS');
  const locationTheatersData = await locationTheatersRes.json();
  assert.deepEqual(locationTheatersData.location, { slug: 'cebu', name: 'Cebu' });
  assert.equal(locationTheatersData.snapshot_date, '2026-08-17');
  assert.equal(locationTheatersData.total_theaters, 1);
  assert.equal(locationTheatersData.theaters.length, 1);
  assert.deepEqual(locationTheatersData.theaters[0], {
    id: 75,
    name: 'Ayala Center Cebu',
    slug: 'ayala-center-cebu',
    theater_type: 'TM',
    branch_id: '7401',
    city: 'Cebu City',
    address1: 'Cebu Business Park',
    address2: null,
    logo_url: 'https://img.test/ayala.png',
    latitude: '10.3173',
    longitude: '123.9048',
    buy_ticket: true,
    mall_group_id: 'ayala',
  });
  console.log('✓ GET /api/locations/:slug returns location metadata and formatted theaters');

  // 13. Movie endpoint: Missing API_BASE_URL (no D1 cache)
  const missingMovieApiRes = await worker.fetch(
    new Request('http://localhost/api/movies/df4c1b', { method: 'GET' }),
    {}
  );
  assert.equal(missingMovieApiRes.status, 500);
  const missingMovieApiBody = await missingMovieApiRes.json();
  assert.match(missingMovieApiBody.error, /Server misconfiguration: API_BASE_URL not set/);
  console.log('✓ GET /api/movies/:hash without API_BASE_URL and no cache returns 500');

  // 14. Movie endpoint: Upstream fetch success + transformation + D1 upsert
  const mockRawMovie = {
    movie_id: 21097,
    hash: 'df4c1b',
    slug: 'paw-patrol-the-dino-movie',
    title: 'PAW Patrol: The Dino Movie',
    synopsis: 'The Paw Patrol lands on a dinosaur island...',
    running_time: '1 hr 28 min',
    release_date: '2026-08-26',
    year_released: '2026',
    opening_date: 'Wed, 26 Aug 2026',
    country: 'United States',
    released_by: 'Columbia Pictures',
    mtrcb_rating: 'G',
    now_showing: true,
    buy_ticket: true,
    poster: 'https://cdn1.clickthecity.com/images/movies/poster/215/21097_3.jpg',
    poster_url: 'https://cdn1.clickthecity.com/images/movies/poster/600/21097_3.jpg',
    youtube_trailer_url: 'd7xEo1GGwE0',
    imdb_url: 'http://www.imdb.com/title/tt29356163/',
    website: 'https://www.paramountpictures.com/movies/paw-patrol-3-the-dino-movie',
    genre_list: [
      { genre_id: 2, slug: 'adventure', name: 'Adventure' },
      { genre_id: 15, slug: 'animation', name: 'Animation' },
    ],
    person_assoc: [
      {
        name: 'Main Cast',
        assoc: [
          {
            person_id: 19191,
            hash: '3L7iFE',
            slug: 'mckenna-grace',
            name: 'Mckenna Grace',
            role: 'Skye (voice)',
            image_url: 'https://cdn1.clickthecity.com/profiles/100/19191_5.jpg',
          },
        ],
      },
    ],
    user_rating: { average: '4.5', total: 10 },
  };

  let savedD1Data = null;
  const mockMovieDb = {
    prepare(query) {
      if (query.includes('SELECT data_json, updated_at')) {
        return {
          bind(hash) {
            return {
              async first() {
                return null; // Cache miss on first check
              },
            };
          },
        };
      }
      if (query.includes('INSERT INTO movie_cache')) {
        return {
          bind(hash, movieId, slug, title, dataJson) {
            return {
              async run() {
                savedD1Data = { hash, movieId, slug, title, dataJson };
                return { success: true };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };

  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://api.mock.test/movies/df4c1b');
    return new Response(
      JSON.stringify({
        status: true,
        data: mockRawMovie,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const movieRes = await worker.fetch(
      new Request('http://localhost/api/movies/df4c1b', { method: 'GET' }),
      { API_BASE_URL: 'https://api.mock.test', DB: mockMovieDb }
    );
    assert.equal(movieRes.status, 200);
    assert.equal(movieRes.headers.get('X-Cache'), 'MISS');
    const movieData = await movieRes.json();

    assert.equal(movieData.id, 21097);
    assert.equal(movieData.hash, 'df4c1b');
    assert.equal(movieData.slug, 'paw-patrol-the-dino-movie');
    assert.equal(movieData.title, 'PAW Patrol: The Dino Movie');
    assert.equal(movieData.runtime, '1 hr 28 min');
    assert.equal(movieData.mtrcb_rating, 'G');
    assert.equal(movieData.now_showing, true);
    assert.equal(movieData.buy_ticket, true);
    assert.equal(movieData.posters.small, 'https://cdn1.clickthecity.com/images/movies/poster/215/21097_3.jpg');
    assert.equal(movieData.posters.large, 'https://cdn1.clickthecity.com/images/movies/poster/600/21097_3.jpg');
    assert.equal(movieData.trailers.youtube_id, 'd7xEo1GGwE0');
    assert.equal(movieData.trailers.youtube_url, 'https://www.youtube.com/watch?v=d7xEo1GGwE0');
    assert.equal(movieData.trailers.imdb_url, 'http://www.imdb.com/title/tt29356163/');
    assert.equal(movieData.trailers.website_url, 'https://www.paramountpictures.com/movies/paw-patrol-3-the-dino-movie');
    assert.equal(movieData.genres.length, 2);
    assert.equal(movieData.genres[0].slug, 'adventure');
    assert.equal(movieData.credits.length, 1);
    assert.equal(movieData.credits[0].category, 'Main Cast');
    assert.equal(movieData.credits[0].members[0].name, 'Mckenna Grace');
    assert.equal(movieData.ratings.user_average, 4.5);
    assert.equal(movieData.ratings.user_total, 10);

    // Verify D1 persistence was called
    assert.ok(savedD1Data);
    assert.equal(savedD1Data.hash, 'df4c1b');
    assert.equal(savedD1Data.movieId, 21097);
    assert.equal(savedD1Data.slug, 'paw-patrol-the-dino-movie');
    assert.equal(savedD1Data.title, 'PAW Patrol: The Dino Movie');
    console.log('✓ GET /api/movies/:hash fetches from upstream, normalizes schema, and persists to D1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 15. Movie endpoint: Fresh D1 cache hit (HIT-D1)
  const cachedPayload = {
    id: 21097,
    hash: 'df4c1b',
    title: 'PAW Patrol: The Dino Movie (Cached)',
    posters: {},
    trailers: {},
    genres: [],
    credits: [],
    ratings: { user_average: 0, user_total: 0 },
  };
  const mockFreshD1Db = {
    prepare(query) {
      assert.match(query, /SELECT data_json, updated_at/);
      return {
        bind(hash) {
          assert.equal(hash, 'df4c1b');
          return {
            async first() {
              return {
                data_json: JSON.stringify(cachedPayload),
                updated_at: new Date().toISOString(), // Fresh (now)
              };
            },
          };
        },
      };
    },
  };
  const freshCacheRes = await worker.fetch(
    new Request('http://localhost/api/movies/df4c1b', { method: 'GET' }),
    { API_BASE_URL: 'https://api.mock.test', DB: mockFreshD1Db }
  );
  assert.equal(freshCacheRes.status, 200);
  assert.equal(freshCacheRes.headers.get('X-Cache'), 'HIT-D1');
  const freshCacheData = await freshCacheRes.json();
  assert.equal(freshCacheData.title, 'PAW Patrol: The Dino Movie (Cached)');
  console.log('✓ GET /api/movies/:hash serves fresh D1 cache with X-Cache: HIT-D1 without upstream fetch');

  // 16. Movie endpoint: Upstream failure with Stale D1 cache fallback (STALE-D1)
  const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago (stale)
  const mockStaleD1Db = {
    prepare(query) {
      return {
        bind(hash) {
          return {
            async first() {
              return {
                data_json: JSON.stringify(cachedPayload),
                updated_at: staleDate,
              };
            },
          };
        },
      };
    },
  };
  globalThis.fetch = async () => {
    return new Response('Upstream Gateway Timeout', { status: 504 });
  };
  try {
    const staleRes = await worker.fetch(
      new Request('http://localhost/api/movies/df4c1b', { method: 'GET' }),
      { API_BASE_URL: 'https://api.mock.test', DB: mockStaleD1Db }
    );
    assert.equal(staleRes.status, 200);
    assert.equal(staleRes.headers.get('X-Cache'), 'STALE-D1');
    assert.equal(staleRes.headers.get('Warning'), '110 - "Response is Stale"');
    const staleData = await staleRes.json();
    assert.equal(staleData.title, 'PAW Patrol: The Dino Movie (Cached)');
    console.log('✓ GET /api/movies/:hash falls back to stale D1 record with X-Cache: STALE-D1 on upstream error');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 17. Movie endpoint: Upstream 404 with no D1 cache
  const mockEmptyMovieDb = {
    prepare(query) {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
          };
        },
      };
    },
  };
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ status: false, message: 'Movie not found' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const notFoundMovieRes = await worker.fetch(
      new Request('http://localhost/api/movies/non-existent', { method: 'GET' }),
      { API_BASE_URL: 'https://api.mock.test', DB: mockEmptyMovieDb }
    );
    assert.equal(notFoundMovieRes.status, 404);
    const notFoundBody = await notFoundMovieRes.json();
    assert.equal(notFoundBody.error, 'Movie not found');
    console.log('✓ GET /api/movies/:hash returns 404 when upstream cannot find movie and no cache exists');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

testWorker().then(() => {
  console.log('\n🎉 All worker tests passed!\n');
}).catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
