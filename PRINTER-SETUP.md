# 🏷️ Label Printer Setup — Plan (for when the Phomemo M220 arrives)

This note captures everything decided so far, so we can pick up without starting over.
It's here in the repo so it's readable from any device (including your phone) via GitHub.

## The goal
When you add a flavor in Geri's Glideria, print a label for that tub with **one tap**.

## Hardware
- **Printer:** Phomemo **M220** (Bluetooth, supports up to 3"/75mm wide labels).
- **Label size:** ~**1" × 3"** (3" wide × 1" tall). Use a **3" (75mm) wide roll** — a
  continuous roll is ideal so the label height can be set to ~1".

## What the label will show
- **Flavor**
- **Date + time made** — the time comes automatically from each tub's `created_at`
  timestamp (already recorded on every add), so there's nothing extra to enter.
- **QR code** — encodes `https://tamar-sofer-geri.github.io/ice-cream-inventory/?tub=<id>`.
  Scanning it opens the app straight to that tub, ready to mark Full/Half. (This deep-link
  already works today.)

## How printing will work
- **One tap:** after adding a flavor, tap a **"Print label"** button.
- **Transport:** **Web Bluetooth** from **Android Chrome** (Chrome supports it; pair the
  printer once, then it's one tap per print). No computer, server, or always-on device —
  the app stays a static site + Supabase, unchanged.
- The label is rendered to a bitmap at the roll's pixel size and sent to the M220 over
  Bluetooth. The M220's exact protocol/sizing gets dialed in with the real printer in hand.

## To resume
Open **Claude Code** in this project (the `Ice cream` folder on the Mac) and say
"the printer arrived." The assistant has this plan saved in project memory too.
Then, on the **Android phone** in **Chrome**, open the app to pair the printer and test.

_Everything is already saved: the app code is on GitHub, and this plan is committed here
and in the assistant's project memory._
