# NeighbourHero Backend API

Standalone Express.js backend for NeighbourHero, ready to deploy to **Render** with PostgreSQL (Supabase / Render Postgres).

---

## 📁 What is in this folder?

- `index.mjs` - Express API entry point (health check, auth, issues, comments, notifications, uploads, staff routes).
- `db.mjs` & `pg.mjs` - PostgreSQL data layer with direct SSL connection & pooler fallbacks.
- `schema.sql` - Database schema (users, profiles, issues, comments, notifications, events).
- `migrate.mjs` & `seed.mjs` - Database migration and demo seeder.
- `vision.mjs` - Optional AI civic photo classifier.
- `google.mjs` & `identity.mjs` - Google OAuth token validation & Indian civic names generator.
- `package.json` - Standalone Node.js dependencies (`express`, `pg`, `cors`, `multer`, `@supabase/supabase-js`).

---

## 🚀 Step 1: Deploy to Render (Quick Guide)

### Option A: Create a New GitHub Repository for Backend (Recommended)

1. Open terminal inside this `backend` folder:
   ```bash
   cd d:\React-Native\Native-Project\neighbourhero\backend
   git init
   git add .
   git commit -m "Initial commit for NeighbourHero backend"
   ```
2. Create a new repository on [GitHub](https://github.com/new) named `neighbourhero-backend`.
3. Push your code:
   ```bash
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/neighbourhero-backend.git
   git push -u origin main
   ```

---

### Step 2: Create Web Service on Render

1. Log in to [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** -> **Web Service**.
3. Select your `neighbourhero-backend` GitHub repository.
4. Fill in the service configuration:
   - **Name**: `neighbourhero-api` (or any name you prefer)
   - **Region**: Choose closest to your users (e.g. `Singapore` or `Frankfurt` or `Oregon`)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`

---

### Step 3: Add Environment Variables in Render

In Render, go to the **Environment** tab of your new Web Service and add the following keys:

| Key | Value | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:PASSWORD@db.YOUR_PROJECT.supabase.co:5432/postgres` | Your Supabase PostgreSQL database URL |
| `SUPABASE_URL` | `https://YOUR_PROJECT.supabase.co` | Your Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhb...` | Supabase Service Role Secret (for image uploads to `issue-photos` bucket) |
| `PUBLIC_API_URL` | `https://neighbourhero-api.onrender.com` | Your Render app URL (shown at the top of your Render service page) |
| `PORT` | `10000` | (Render sets this automatically, but you can specify 10000) |
| `GEMINI_API_KEY` | *(Optional)* | Your Gemini or Google AI API Key for photo classification |

Click **Save Changes**. Render will automatically deploy!

---

### Step 4: Verify the Backend is Live

Once Render shows **Deploy Succeeded** (green status), open your browser and visit:
```
https://neighbourhero-api.onrender.com/
```
You should see:
```json
{
  "status": "online",
  "service": "NeighbourHero API",
  "database": "supabase",
  "time": "2026-..."
}
```
And check `/health`:
```
https://neighbourhero-api.onrender.com/health
```
It should report `"ok": true`.

---

## 🗄️ Step 5: Database Tables Setup

If you haven't run database migrations yet, you have two simple options:

1. **Option A (Easiest)**:
   - Open your [Supabase Dashboard](https://supabase.com/dashboard) -> Select your project -> Go to **SQL Editor**.
   - Copy the contents of `schema.sql` and click **Run**.
2. **Option B (From terminal)**:
   - In this `backend` folder with your `.env` configured, run:
     ```bash
     npm run db:push
     ```

---

## 📱 Step 6: Connect your React Native / Expo APK

In your React Native project root (one folder up):

1. Open `.env` and set:
   ```env
   EXPO_PUBLIC_API_URL=https://neighbourhero-api.onrender.com
   ```
   *(Replace with your actual Render URL! Note: use **https://**, not http://)*

2. **Re-build your APK**:
   ```bash
   eas build -p android --profile preview
   ```
   *(Or your standard build command)*.

> **Why must you re-build the APK?**
> Expo / React Native embeds `EXPO_PUBLIC_*` values into the APK at build time. The existing APK on your phone is still pointing to your local Wi-Fi IP (`192.168.1.9`). A new APK built with the Render URL will connect to the cloud database from anywhere in the world!

