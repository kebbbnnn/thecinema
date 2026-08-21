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
Node.js v18+ is required. No `npm install` needed — this repository has zero npm dependencies!

### 2. Create Cloudflare D1 Database
Make sure you are logged in to Cloudflare CLI:
```bash
npx wrangler login
```

Create your D1 database:
```bash
npx wrangler d1 create thecinema-db
```
Copy the `database_id` output by Wrangler and paste it into [`wrangler.toml`](./wrangler.toml).

### 3. Run Migrations
Apply the initial schema to your remote D1 database:
```bash
npm run db:migrate:remote
```
*(Or test locally with `npm run db:migrate:local`)*

### 4. Configure GitHub Repository Secrets
In your GitHub repository, go to **Settings > Secrets and variables > Actions** and add the following repository secrets:

| Secret Name | Description | Where to find |
|---|---|---|
| `API_BASE_URL` | Base API endpoint URL | Secret / API provider URL |
| `CLOUDFLARE_API_TOKEN` | API Token with **D1 Edit** permissions | Cloudflare Dashboard > My Profile > API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID | Cloudflare Dashboard URL or Worker overview |
| `D1_DATABASE_NAME` | D1 database name (optional, defaults to `thecinema-db`) | Your wrangler.toml / D1 dashboard |
| `D1_DATABASE_ID` | D1 database UUID | Output from `wrangler d1 create` |

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

A Cloudflare Worker that proxies the upstream movie schedule API, caches responses at the edge (1-hour TTL), and transforms showtimes into a movie-centric format.

### Endpoint

```http
GET /api/theater/:slug?date=YYYY-MM-DD
```

- `:slug` — Theater slug (e.g. `kcc-mall-of-gensan`, `ayala-center-cebu`)
- `date` *(optional)* — Date in `YYYY-MM-DD` format. Defaults to today in Philippine Time (UTC+8).

### Transformed Response Format

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

### Worker Deployment & Setup

1. **Set the upstream API secret in Cloudflare**:
   ```bash
   npx wrangler secret put API_BASE_URL
   ```

2. **Run locally**:
   ```bash
   npm run dev
   ```

3. **Deploy to Cloudflare Workers**:
   ```bash
   npm run deploy
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
