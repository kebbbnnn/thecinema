# Theater Image Management & Dashboard Design Specification

## 1. Executive Summary
This document specifies the technical design for adding custom theater photography to movie theaters in the cinema platform. The architecture introduces an ImageKit.io media pipeline, Cloudflare D1 persistence decoupled from the daily scraping pipeline, authenticated Cloudflare Worker admin endpoints, and a standalone React/Vite admin dashboard hosted on Render.com.

---

## 2. Decision Log

| Area | Decision | Considered Alternatives | Rationale |
| :--- | :--- | :--- | :--- |
| **Image Hosting** | **ImageKit.io** | Cloudflare R2, Imgur, Cloudinary, Supabase Storage | 20 GB free tier, global CDN, no credit card required, reliable REST upload API, on-the-fly WebP/AVIF format optimization. |
| **Dashboard Host** | **Render.com (Static Site)** | Cloudflare Pages, Embedded in Worker, Mobile app screen | Zero cold-start latency, free global hosting, distinct frontend decoupling. |
| **Upload Pipeline** | **Worker-Mediated Upload** | Direct client upload via signed tokens, Full Node backend on Render | Secret API keys (`IMAGEKIT_PRIVATE_KEY`) remain strictly protected in Cloudflare Worker secrets; zero server setup needed on Render. |
| **API Delivery** | **Unified `image_url` with Fallback** | Separate `custom_image_url` & `logo_url` | Single source of truth for client app (`noodtayo`); automatically falls back from custom ImageKit photo to upstream logo or `null`. |
| **Persistence** | **Dedicated `theater_custom_images` Table** | Modifying `theater_snapshots` | Decouples custom user-uploaded imagery from the daily snapshot pipeline (`scripts/fetch-theaters.js`), preventing data loss during daily runs. |

---

## 3. Architecture & Data Flow

```
+-------------------------------------------------------------+
|                Admin Dashboard (Render.com)                 |
|             React + Vite SPA / Static Site                  |
+------------------------------+------------------------------+
                               |
               1. Multipart Form Upload (X-Admin-Key)
                               v
+-------------------------------------------------------------+
|             Cloudflare Worker (thecinema)                   |
|  - Validates X-Admin-Key                                    |
|  - Encodes & relays to ImageKit upload API                  |
|  - Writes ImageKit URL & fileId to D1                       |
+---------------+-----------------------------+---------------+
                |                             |
     2. Upload Media               3. Upsert Metadata
                v                             v
+-------------------------------+ +---------------------------+
|         ImageKit.io           | |       Cloudflare D1       |
|  - Stores master images       | |  `theater_custom_images`  |
|  - Global CDN & compression   | |  - slug (PK)              |
+---------------+---------------+ |  - image_url              |
                |                 |  - file_id                |
                |                 +-------------+-------------+
                |                               |
                |       4. Public Schedule /    |
                |          Location Queries     |
                |                               v
                +-----------------> +-------------------------+
                                    |    Mobile App (Client)  |
                                    |        (noodtayo)       |
                                    +-------------------------+
```

---

## 4. Detailed Component Specifications

### 4.1 Database Migration: `0003_theater_custom_images.sql`
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

CREATE INDEX IF NOT EXISTS idx_custom_images_slug ON theater_custom_images(slug);
```

### 4.2 Worker Environment Variables & Secrets
* `ADMIN_API_KEY`: Secret string header token.
* `IMAGEKIT_PRIVATE_KEY`: Private API key for ImageKit REST API basic authentication.
* `IMAGEKIT_URL_ENDPOINT`: e.g. `https://ik.imagekit.io/<your_imagekit_id>`

### 4.3 Worker Endpoints
1. `GET /api/admin/theaters`
   * Protected with `X-Admin-Key`.
   * Returns list of all theaters from the latest snapshot combined with `theater_custom_images` status (`has_custom_image`, `image_url`, `logo_url`, `city`, `province`).
2. `POST /api/admin/theaters/:slug/image`
   * Protected with `X-Admin-Key`.
   * Accepts `multipart/form-data` with `file` (JPEG, PNG, WebP up to 5MB).
   * Relays to `https://upload.imagekit.io/api/v1/files/upload`.
   * Upserts into `theater_custom_images` table in D1.
3. `DELETE /api/admin/theaters/:slug/image`
   * Protected with `X-Admin-Key`.
   * Deletes asset from ImageKit and removes row from `theater_custom_images`.
4. `GET /api/theater/:slug` (Public)
   * Enriched with `theater.image_url` (D1 custom image or fallback).
5. `GET /api/locations/:slug` (Public)
   * SQL query joined with `theater_custom_images` to attach `image_url` on all theater cards.

### 4.4 Admin Dashboard (Render.com SPA)
* **Stack**: React + Vite + CSS/Tailwind.
* **Auth**: Stored `adminKey` and `apiUrl` in local storage.
* **Features**:
  * Status metrics (Total Theaters, Uploaded Photos, Missing Photos).
  * Fast search & filter by Province and Image status.
  * Drag-and-drop file upload with live preview and upload feedback.
  * Delete/replace action buttons with confirmations.

---

## 5. Non-Functional Requirements & Security
* **Access Control**: Public users cannot invoke `/api/admin/*` endpoints without valid `X-Admin-Key`.
* **Payload Validation**: Server-side MIME check (`image/jpeg`, `image/png`, `image/webp`) and 5MB limit.
* **Reliability**: ImageKit uploads operate independently of daily scraping crons.
