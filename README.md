# 🍨 Geri's Glideria

A mobile-friendly web app to track an ice cream inventory, **synced across devices and people** in real time via a shared [Supabase](https://supabase.com) database. No build step — plain HTML/CSS/JavaScript hosted on GitHub Pages.

Each row is one physical container of a flavor, shown as **full** or **half**. Tap a button when you eat some:

- **Full** — you finished a whole container → it's removed.
- **Half** — you ate half → a **full** container becomes **half**; a **half** container is finished and removed.
- **➕** — add containers: pick a flavor, **how many** to add at once, and the **date made** (defaults to today, editable).

There are two pages, switched via the bottom tab bar:

- **Containers** — every container, sorted alphabetically so the same flavors group together. Each shows a tub icon (filled = full, outline with ½ = half) and its date.
- **Inventory** — a running tally of **empty containers** at the top, plus a count per flavor (e.g. "3 Vanilla"). Tap a flavor to expand it and see the date each container was made.

Whenever a container is finished (the **Full** button, or **Half** on a container that was already half), the empty-container tally goes up by one. **Reset** zeroes it (e.g. after you recycle the empties).

Changes made on one device appear on the others automatically (real-time). A `localStorage` copy is kept as an offline cache so the app still paints instantly if the network is momentarily unavailable.

## Live app

**<https://tamar-sofer-geri.github.io/ice-cream-inventory/>**

On your phone, open the link and use your browser's **Add to Home Screen** to install it like an app.

## Configuration

Backend connection lives in `config.js`:

```js
window.GLIDERIA_CONFIG = {
  supabaseUrl: "https://<project>.supabase.co",
  supabaseAnonKey: "<anon public key>"
};
```

Both values are safe to commit — the `anon` key is a public client key, and access is governed by the table's Row Level Security policies. If these are left blank, the app runs in **local-only mode** (device-only, no sync).

### Database schema

The Supabase project has one table, `public.containers`, created with:

```sql
create table if not exists public.containers (
  id uuid primary key default gen_random_uuid(),
  flavor text not null,
  state text not null default 'full' check (state in ('full','half')),
  date_made date not null default current_date,
  created_at timestamptz not null default now()
);
alter table public.containers enable row level security;
create policy "public read"   on public.containers for select using (true);
create policy "public insert" on public.containers for insert with check (true);
create policy "public update" on public.containers for update using (true) with check (true);
create policy "public delete" on public.containers for delete using (true);
alter publication supabase_realtime add table public.containers;
```

Plus a `public.empties` table (one row per finished container; the tally is its row count):

```sql
create table if not exists public.empties (
  id uuid primary key default gen_random_uuid(),
  emptied_at timestamptz not null default now()
);
alter table public.empties enable row level security;
create policy "public read"   on public.empties for select using (true);
create policy "public insert" on public.empties for insert with check (true);
create policy "public delete" on public.empties for delete using (true);
alter publication supabase_realtime add table public.empties;
```

> Access is currently **open** (anyone with the app can read/write). To lock it down later, tighten these policies or add Supabase Auth.

## Run locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. It talks to the same Supabase project, so local changes sync too.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Header, two views, bottom tab bar, add-container modal |
| `styles.css` | Blue theme, mobile-first styling |
| `app.js` | Supabase data access, real-time sync, rendering, actions |
| `config.js` | Supabase URL + anon key |
| `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png` | Home-screen install support |
