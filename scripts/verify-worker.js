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
}

testWorker().then(() => {
  console.log('\n🎉 All worker tests passed!\n');
}).catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
