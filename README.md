# 🍦 Ice Cream Inventory

A tiny mobile-friendly web app to track your ice cream inventory — one screen, no accounts, no backend.

Each row is one physical container of a flavor, shown as **full** or **half**. Tap a button when you eat some:

- **Full** — you finished a whole container → the row is removed.
- **Half** — you ate half → a **full** container becomes **half**; a **half** container is finished and removed.
- **➕** — add a new full container of any flavor.

The container icon on the left reflects the current fill (full or ½). Your inventory is saved on the device using the browser's `localStorage`, so it survives reloads.

## Live app

_(GitHub Pages URL will go here once published.)_

On your phone, open the link and use your browser's **Add to Home Screen** to install it like an app.

## Run locally

It's plain HTML/CSS/JavaScript — no build step. From this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000> in your browser. (Opening `index.html` directly works too, but serving it avoids any browser file-URL restrictions.)

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Screen structure and the add-container modal |
| `styles.css` | Mobile-first styling |
| `app.js` | Inventory state, persistence, and button actions |
| `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png` | Home-screen install support |

## Notes

- Inventory is stored **per device/browser** — it does not sync across devices (that would need a backend, a possible future addition).
