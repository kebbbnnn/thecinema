# Theater Image Management & Dashboard Design Specification

## 1. Executive Summary
This document specifies the technical design for adding custom theater photography to movie theaters in the cinema platform. The architecture introduces an ImageKit.io media pipeline, Cloudflare D1 persistence decoupled from the daily scraping pipeline, authenticated Cloudflare Worker admin endpoints with safe reference-counted asset lifecycle management, and a standalone React/Vite admin dashboard with a Media Library photo picker hosted on Render.com.

---

## 2. Decision Log

| Area | Decision | Considered Alternatives | Rationale |
| :--- | :--- | :--- | :--- |
| **Image Hosting** | **ImageKit.io** | Cloudflare R2, Imgur, Cloudinary, Supabase Storage | 20 GB free tier, global CDN, no credit card required, reliable REST upload API, on-the-fly WebP/AVIF format optimization. |
| **Dashboard Host** | **Render.com (Static Site)** | Cloudflare Pages, Embedded in Worker, Mobile app screen | Zero cold-start latency, free global hosting, distinct frontend decoupling. |
| **Upload & Link Pipeline** | **Dual-Format Endpoint (Multipart + JSON)** | Separate `/link` route, Client direct upload | A single endpoint handles both new binary file uploads and linking existing ImageKit assets without code duplication. |
| **Asset Reuse & Deletion** | **Reference-Counted Safe Cleanup** | Blind deletion, Manual asset management | Checks `COUNT(*) WHERE file_id = ? AND slug != ?` before deleting from ImageKit; prevents broken images when sister branches share a photo. |
| **Media Selection UX** | **Visual Gallery Modal** | Dropdown picker, Hash auto-dedup | Clear visual confirmation of existing photos with 1-click assignment across sister cinema branches. |
| **API Delivery** | **Unified `image_url` with Fallback** | Separate `custom_image_url` & `logo_url` | Single source of truth for client app (`noodtayo`); automatically falls back from custom ImageKit photo to upstream logo or `null`. |
| **Persistence** | **Dedicated `theater_custom_images` Table** | Modifying `theater_snapshots` | Decouples custom user-uploaded imagery from the daily snapshot pipeline (`scripts/fetch-theaters.js`), preventing data loss during daily runs. |

---

## 3. Architecture & Data Flow

```
+-------------------------------------------------------------------------+
|                      Admin Dashboard (Render.com)                       |
|       - Drag-and-Drop Uploader      - Visual Media Library Modal        |
+-----------------------------------+-------------------------------------+
                                    |
            1. Fresh File (Multipart) OR Reuse Asset (JSON Link)
                                    v
+-------------------------------------------------------------------------+
|                   Cloudflare Worker (thecinema)                         |
|  - Validates X-Admin-Key                                                |
|  - Fresh file -> uploads to ImageKit & updates D1                       |
|  - Reuse asset -> validates & directly updates D1                       |
|  - Replaced/Deleted -> Safe reference-counted cleanup on ImageKit        |
+-------------------+---------------------------------+-------------------+
                    |                                 |
         2. ImageKit Operations               3. Upsert Metadata
                    v                                 v
+-----------------------------------+ +-----------------------------------+
|            ImageKit.io            | |           Cloudflare D1           |
|  - Stores master images           | |     `theater_custom_images`       |
|  - Global CDN & transformations   | |     - slug (PK)                   |
+-------------------+---------------+ |     - file_id                     |
                    |                 |     - image_url                   |
                    |                 +---------------+-------------------+
                    |                                 |
                    |          4. Public Schedule /   |
                    |             Location Queries    |
                    |                                 v
                    +-------------------> +-------------------------------+
                                          |      Mobile App (Client)      |
                                          |          (noodtayo)           |
                                          +-------------------------------+
```

---

## 4. Detailed Component Specifications

### 4.1 Database Table: `theater_custom_images`
```sql
CREATE TABLE IF NOT EXISTS theater_custom_images (
  slug TEXT PRIMARY KEY,
  theater_id INTEGER,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  file_id TEXT,
  thumbnail_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_theater_custom_images_slug ON theater_custom_images (slug);
```

### 4.2 Worker Secrets & Environment Variables
* `ADMIN_API_KEY`: Secret string header token.
* `IMAGEKIT_PRIVATE_KEY`: Private API key for ImageKit REST API basic authentication.
* `IMAGEKIT_URL_ENDPOINT`: e.g. `https://ik.imagekit.io/<your_imagekit_id>`

### 4.3 Worker Endpoints & Safe Cleanup
1. `GET /api/admin/theaters`
   * Protected with `X-Admin-Key`.
   * Returns list of all theaters from the latest snapshot joined with `theater_custom_images` status.
2. `POST /api/admin/theaters/:slug/image`
   * Protected with `X-Admin-Key`.
   * **Mode 1 (Multipart)**: Accepts image file, uploads to ImageKit, upserts D1, and safely cleans up old file if not shared.
   * **Mode 2 (JSON)**: Accepts `{ image_url, file_id, thumbnail_url, name, theater_id }`, directly upserts D1 to link asset, and safely cleans up old file if not shared.
3. `DELETE /api/admin/theaters/:slug/image`
   * Protected with `X-Admin-Key`.
   * Checks reference count: `SELECT COUNT(*) FROM theater_custom_images WHERE file_id = ? AND slug != ?`.
   * Deletes from ImageKit only if count is 0, and removes the D1 row.
4. `GET /api/theater/:slug` (Public)
   * Enriched with `theater.image_url` (D1 custom image or fallback).
5. `GET /api/locations/:slug` (Public)
   * SQL query joined with `theater_custom_images` to attach `image_url` on all theater cards.

### 4.4 Admin Dashboard (Render.com SPA)
* **Stack**: React + Vite + CSS.
* **Media Library Modal**:
  * Visual gallery displaying all unique photos currently uploaded across your cinemas.
  * Shows list of theaters sharing each photo.
  * 1-click assignment button to link selected photo to target theater.
* **Theater Card Actions**:
  * "Upload / Change Photo"
  * "Pick from Library" (opens modal)
  * "Preview Full Photo" (lightbox)
  * "Delete Photo" (with confirmation)
