# 🎬 The Cinema — Data Pipeline

A zero-budget data pipeline running on GitHub Actions that fetches movie theater listings across the Philippines weekly and stores them in Cloudflare D1.

## 🕒 Schedule & Data Strategy

| Schedule | Run Time (PHT) | Run Time (UTC) | Strategy |
|---|---|---|---|
| **Every Monday** | `12:00 AM PHT` | `16:00 UTC Sunday` | Replaces the week's snapshot with fresh listings |

- **Weekly Snapshots**: Theater listings rarely change, so a single weekly sync keeps data fresh without wasting resources.
- **Observability**: Every run logs per-location fetch status, theater count, and any error details to `fetch_log`.

---

## 🗄️ Database Schema

### `theater_snapshots`
Stores theater records for each daily snapshot.

```sql
CREATE TABLE theater_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,         -- 'YYYY-MM-DD' in Philippine Time (UTC+8)
  province_slug TEXT NOT NULL,         -- e.g. 'cebu', 'quezon-city'
  theater_id INTEGER NOT NULL,         -- ID from API
  theater_type TEXT,                   -- e.g. 'TM'
  slug TEXT,                           -- e.g. 'ayala-center-cebu'
  branch_id TEXT,                      -- e.g. '7401'
  name TEXT NOT NULL,                  -- e.g. 'Ayala Center Cebu'
  address1 TEXT,
  address2 TEXT,
  city TEXT,
  logo_url TEXT,
  longitude TEXT,
  latitude TEXT,
  buy_ticket INTEGER DEFAULT 0,        -- 0 = false, 1 = true
  mall_group_id TEXT,
  province TEXT,                       -- Display name from API e.g. 'Cebu'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### `fetch_log`
Tracks every fetch attempt per location.

```sql
CREATE TABLE fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,         -- 'YYYY-MM-DD' (PHT)
  run_type TEXT NOT NULL,              -- 'initial' or 'refresh'
  province_slug TEXT NOT NULL,
  location_name TEXT,
  theater_count INTEGER DEFAULT 0,
  status TEXT NOT NULL,                -- 'success' or 'error'
  error_message TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);
```

---

## 🚀 Setup & Cloudflare Configuration

### 1. Prerequisites
Node.js v18+ is required. No `npm install` needed — this repository has zero permanent npm dependencies! All CLI operations use `npx -y wrangler`.

### 2. Authenticate Cloudflare CLI
Log in to your Cloudflare account via browser:
```bash
npx -y wrangler login
```

Verify your active session:
```bash
npx -y wrangler whoami
```

### 3. Create or Link Cloudflare D1 Database
Create your D1 database:
```bash
npx -y wrangler d1 create thecinema-db
```

Or list existing databases to find your UUID:
```bash
npx -y wrangler d1 list
```

Copy the `database_id` output and paste it into [`wrangler.toml`](./wrangler.toml):
```toml
[[d1_databases]]
binding = "DB"
database_name = "thecinema-db"
database_id = "your-database-uuid"
migrations_dir = "migrations"
```

### 4. Run Migrations
Apply all schema migrations (`0001_initial_schema.sql`, `0002_movie_cache.sql`) to your remote D1 database:
```bash
npm run db:migrate:remote
```

*(To test against local SQLite during development: `npm run db:migrate:local`)*

### 5. Configure Worker Secret
Set the upstream API base URL secret in Cloudflare:
```bash
npx -y wrangler secret put API_BASE_URL
```
*(Enter `https://www.clickthecity.com/api` when prompted)*

### 6. Configure GitHub Repository Secrets (For Weekly Pipeline)
In your GitHub repository, go to **Settings > Secrets and variables > Actions** and add the following repository secrets:

| Secret Name | Description | Where to find |
|---|---|---|
| `API_BASE_URL` | Base API endpoint URL | `https://www.clickthecity.com/api` |
| `CLOUDFLARE_API_TOKEN` | API Token with **D1 Edit** permissions | Cloudflare Dashboard > My Profile > API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID | Output from `npx -y wrangler whoami` |
| `D1_DATABASE_NAME` | D1 database name (optional, defaults to `thecinema-db`) | Your wrangler.toml / D1 dashboard |
| `D1_DATABASE_ID` | D1 database UUID | Output from `npx -y wrangler d1 list` |

---

## 🧪 Local Testing & Dry-Run

You can test fetching all 55 locations without writing to D1:

```bash
# Fetch and print summary without DB writes
npm run fetch-theaters:dry-run
```

To test against a local D1 database:
```bash
# Apply migrations to local sqlite
npm run db:migrate:local

# Run fetch script targeting local D1
node scripts/fetch-theaters.js --local
```

---

---

## ⚡ Movie Schedule Proxy Worker

A Cloudflare Worker that provides endpoints for querying available movie theater locations from D1 and proxying/caching movie schedule showtimes from the upstream API.

### Endpoints

#### 1. Get Available Locations
```http
GET /api/locations
```

Returns all provinces and Metro Manila cities that have theater data in the latest D1 snapshot, grouped by location type, along with theater counts. Cached at the edge for 1 hour (`Cache-Control: public, max-age=3600`).

**Response Format:**
```json
{
  "snapshot_date": "2026-08-17",
  "provinces": [
    {
      "slug": "cebu",
      "name": "Cebu",
      "theater_count": 8
    },
    {
      "slug": "pampanga",
      "name": "Pampanga",
      "theater_count": 5
    }
  ],
  "metro_manila": [
    {
      "slug": "makati",
      "name": "Makati",
      "theater_count": 6
    },
    {
      "slug": "quezon-city",
      "name": "Quezon City",
      "theater_count": 14
    }
  ]
}
```

#### 2. Get Theaters by Location
```http
GET /api/locations/:slug
```

- `:slug` — Province or Metro Manila city slug (e.g. `cebu`, `quezon-city`, `makati`)

Returns all theaters and metadata for the given location in the latest D1 snapshot. Cached at the edge for 1 hour (`Cache-Control: public, max-age=3600`).

**Response Format:**
```json
{
  "location": {
    "slug": "cebu",
    "name": "Cebu"
  },
  "snapshot_date": "2026-08-17",
  "total_theaters": 1,
  "theaters": [
    {
      "id": 75,
      "name": "Ayala Center Cebu",
      "slug": "ayala-center-cebu",
      "theater_type": "TM",
      "branch_id": "7401",
      "city": "Cebu City",
      "address1": "Cebu Business Park, Archbishop Reyes Ave.",
      "address2": null,
      "logo_url": "https://cdn.example.com/logo.png",
      "latitude": "10.3173",
      "longitude": "123.9048",
      "buy_ticket": true,
      "mall_group_id": "ayala"
    }
  ]
}
```

#### 3. Get Theater Showtimes
```http
GET /api/theater/:slug?date=YYYY-MM-DD
```

- `:slug` — Theater slug (e.g. `kcc-mall-of-gensan`, `ayala-center-cebu`)
- `date` *(optional)* — Date in `YYYY-MM-DD` format. Defaults to today in Philippine Time (UTC+8).

**Transformed Response Format:**

```json
{
  "theater": {
    "id": 342,
    "name": "KCC Mall of Gensan",
    "slug": "kcc-mall-of-gensan",
    "city": "General Santos City",
    "address": "Jose Catolico Sr. Ave., Brgy. Lagao",
    "latitude": "125.186...",
    "longitude": "6.116...",
    "screens": 6
  },
  "date": "2026-08-21",
  "available_schedule": [
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
    "2026-08-24",
    "2026-08-25"
  ],
  "movies": [
    {
      "id": 21138,
      "title": "Insidious: Out of the Further",
      "poster": "https://cdn1.clickthecity.com/images/movies/poster/21138_6.jpg",
      "mtrcb_rating": "R-13",
      "running_time": "1 hr 45 min",
      "in3d": false,
      "showtimes": [
        {
          "screen": "Cinema 1",
          "screen_slug": "kcc-mall-of-gensan-cinema-1",
          "times": ["11:00 AM", "1:30 PM", "4:00 PM", "6:30 PM", "9:00 PM"]
        },
        {
          "screen": "Cinema 3",
          "screen_slug": "kcc-mall-of-gensan-cinema-3",
          "times": ["10:10 AM", "12:30 PM", "3:00 PM", "5:30 PM", "9:00 PM"]
        }
      ]
    }
  ]
}
```

#### 4. Get Movie Full Details
```http
GET /api/movies/:hash
```

- `:hash` — Movie hash identifier (e.g. `df4c1b`, `3L7iFE`)

Returns full details for a movie (synopsis, runtime, release date, genres, posters, full trailers, grouped cast and crew, ratings). Implements two-tier caching (Cloudflare Edge Cache for 24 hours + Cloudflare D1 persistent document cache with 7-day TTL and resilient fallback).

**Headers:**
- `Cache-Control: public, max-age=86400`
- `X-Cache: HIT | HIT-D1 | MISS | STALE-D1`

**Transformed Response Format:**

```json
{
  "id": 21097,
  "hash": "df4c1b",
  "slug": "paw-patrol-the-dino-movie",
  "title": "PAW Patrol: The Dino Movie",
  "synopsis": "The Paw Patrol lands on a mysterious dinosaur island after a storm, where they meet Rex, a stranded pup. When Humdinger's reckless mining triggers a volcano, the team faces their biggest rescue mission yet to save the island.",
  "runtime": "1 hr 28 min",
  "release_date": "2026-08-26",
  "year_released": "2026",
  "opening_date": "Wed, 26 Aug 2026",
  "country": "United States",
  "released_by": "Columbia Pictures",
  "mtrcb_rating": "G",
  "now_showing": true,
  "buy_ticket": true,
  "posters": {
    "small": "https://cdn1.clickthecity.com/images/movies/poster/215/21097_3.jpg",
    "large": "https://cdn1.clickthecity.com/images/movies/poster/600/21097_3.jpg"
  },
  "trailers": {
    "youtube_id": "d7xEo1GGwE0",
    "youtube_url": "https://www.youtube.com/watch?v=d7xEo1GGwE0",
    "imdb_url": "http://www.imdb.com/title/tt29356163/",
    "website_url": "https://www.paramountpictures.com/movies/paw-patrol-3-the-dino-movie"
  },
  "genres": [
    { "id": 2, "slug": "adventure", "name": "Adventure" },
    { "id": 15, "slug": "animation", "name": "Animation" }
  ],
  "credits": [
    {
      "category": "Main Cast",
      "members": [
        {
          "id": 19191,
          "hash": "3L7iFE",
          "slug": "mckenna-grace",
          "name": "Mckenna Grace",
          "role": "Skye (voice)",
          "image_url": "https://cdn1.clickthecity.com/profiles/100/19191_5.jpg"
        }
      ]
    }
  ],
  "ratings": {
    "user_average": 0.0,
    "user_total": 0
  }
}
```

### Worker Deployment & Setup

1. **Set Upstream API Secret in Cloudflare** *(One-time)*:
   ```bash
   npx -y wrangler secret put API_BASE_URL
   ```
   *(Enter `https://www.clickthecity.com/api`)*

2. **Apply Database Migrations to Remote D1**:
   ```bash
   npm run db:migrate:remote
   ```

3. **Deploy Worker to Production**:
   ```bash
   npm run deploy
   ```

4. **Local Development**:
   ```bash
   # Run local D1 migrations
   npm run db:migrate:local

   # Start local dev worker
   npm run dev
   ```

---

## 📍 Covered Locations (55 Total)

### 40 Provinces:
- Agusan del Norte, Aklan, Albay, Antique, Baguio, Bataan, Batangas, Bukidnon, Bulacan, Cagayan
- Camarines Norte, Camarines Sur, Capiz, Cavite, Cebu, Davao del Norte, Davao del Sur, Ilocos Norte, Iloilo, Isabela
- La Union, Laguna, Lanao Del Norte, Leyte, Maguindanao del Norte, Misamis Oriental, Negros Occidental, Negros Oriental, Nueva Ecija, Oriental Mindoro
- Palawan, Pampanga, Pangasinan, Quezon, Rizal, Sorsogon, South Cotabato, Tarlac, Zambales, Zamboanga del Sur

### 15 Cities:
- Caloocan, Las Piñas (`las-pinas`), Makati, Malabon, Mandaluyong
- Manila, Marikina, Muntinlupa, Parañaque (`paranaque`), Pasay
- Pasig, Quezon City, San Juan, Taguig, Valenzuela
