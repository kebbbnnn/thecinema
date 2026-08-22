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
}

testWorker().then(() => {
  console.log('\n🎉 All worker tests passed!\n');
}).catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
