# 🍨 Geri's Glideria

A mobile-friendly web app to track an ice cream inventory, **synced across devices and people** in real time via a shared [Supabase](https://supabase.com) database. No build step — plain HTML/CSS/JavaScript hosted on GitHub Pages.

Each row is one physical container of a flavor, shown as **full**, **half**, or **low** (less than half). Tap the button on a row to cycle through it:

- **Going** (solid purple) — the tub is full. Tap → becomes **half**.
- **Going** (lighter purple) — about half left. Tap → becomes **low**.
- **Gone** (empty/white) — just dregs left. Tap → the tub is finished and removed.
- **➕** — add containers: pick a flavor, **how many** to add at once, the **date made** (defaults to today, editable), and optional **notes** (e.g. recipe tweaks).

Dates, flavors, and notes for each container can be edited later from the **Inventory** page (expand a flavor). Tapping a container's name on the **Flavors** page jumps to it on the **Inventory** page, with its flavor group expanded and the tub briefly highlighted. Opening the app with a `?tub=<container-id>` link (e.g. from a scanned QR label) jumps the other way — to the **Flavors** page — and highlights that exact container, ready to mark Full/Half.

There are three pages, switched via the bottom tab bar:

- **Containers** — every container, sorted alphabetically so the same flavors group together. Each shows a tub icon (solid fill = full, top half white/bottom half filled = half, thin fill at the bottom = low) and its date.
- **Inventory** — a running tally of **empty containers** at the top, plus a count per flavor (shown as a tub with the number inside). Tap a flavor to expand it and see the date each container was made. Long-press a flavor's name to open its recipe, editable right there and shared across every tub of that flavor (e.g. all "FroYo" tubs point to one recipe).
- **Analytics** — consumption over time (Week / Month / Year, filterable by flavor), an all-time by-flavor breakdown, average wait time per flavor (made → eaten), and which tubs have been sitting longest right now.

After tapping the cycling button, a brief **Undo** bar appears at the bottom (~2.5s) to reverse an accidental tap.

Whenever a container is finished (tapping **Gone**), the empty-container tally goes up by one. Adding new tubs draws the tally back **down** by however many you add (it never goes below zero), on the assumption you refilled empties. **Reset** zeroes it manually.

Changes made on one device appear on the others automatically (real-time). A `localStorage` copy is kept as an offline cache so the app still paints instantly if the network is momentarily unavailable.

## Live app

**<https://tamar-sofer-geri.github.io/ice-cream-inventory/>**

On your phone, open the link and use your browser's **Add to Home Screen** to install it like an app.

### Demo mode

Add `?demo=1` to the URL — **<https://tamar-sofer-geri.github.io/ice-cream-inventory/?demo=1>** — for a shareable sandbox. It runs entirely in the visitor's browser (never connects to Supabase), is seeded with sample flavors, and has a **Reset demo** button. Nothing done in demo mode can affect the real inventory.

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
  state text not null default 'full' check (state in ('full','half','low')),
  date_made date not null default current_date,
  notes text,
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

And a `public.consumptions` table (immutable history powering the Analytics page — one row per finished tub):

```sql
create table if not exists public.consumptions (
  id uuid primary key default gen_random_uuid(),
  flavor text not null,
  date_made date,
  consumed_at timestamptz not null default now(),
  notes text
);
alter table public.consumptions enable row level security;
create policy "public read"   on public.consumptions for select using (true);
create policy "public insert" on public.consumptions for insert with check (true);
create policy "public delete" on public.consumptions for delete using (true);
alter publication supabase_realtime add table public.consumptions;
```

And a `public.flavor_recipes` table (one row per flavor, opened by long-pressing a flavor's name on the Inventory page):

```sql
create table if not exists public.flavor_recipes (
  flavor text primary key,
  recipe text,
  updated_at timestamptz not null default now()
);
alter table public.flavor_recipes enable row level security;
create policy "public read"   on public.flavor_recipes for select using (true);
create policy "public insert" on public.flavor_recipes for insert with check (true);
create policy "public update" on public.flavor_recipes for update using (true) with check (true);
create policy "public delete" on public.flavor_recipes for delete using (true);
alter publication supabase_realtime add table public.flavor_recipes;
```

> **Migrating an existing database:** if your `consumptions` table was created before the `notes` column existed, run this once in the Supabase SQL editor:
> ```sql
> alter table public.consumptions add column if not exists notes text;
> ```
>
> **Migrating for the "low" (less-than-half) state:** if your `containers` table's `state` check constraint only allows `'full'` and `'half'`, widen it so the app can save the new `low` state:
> ```sql
> alter table public.containers drop constraint if exists containers_state_check;
> alter table public.containers add constraint containers_state_check check (state in ('full','half','low'));
> ```
> (If Postgres named your constraint something other than the default `containers_state_check`, find its real name first with `select conname from pg_constraint where conrelid = 'public.containers'::regclass and contype = 'c';` and drop that instead.)

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
