# Grand Calendar

A free events and programs app for Waterloo Region and Stratford, Ontario, built as a Home Screen web app on GitHub Pages. It gathers events and registered programs from public sources into one list, with filters for adults, families and kids, so you don't have to search each site separately.

Live at: https://casimbahadar.github.io/grand-calendar/

## What it does

- **Events** from Explore Waterloo Region and Waterloo Public Library, merged into one list for today, the weekend, the next two weeks or chosen dates.
- **Who it's for:** Everyone, Family, or Kids (ages set in Settings, 5 to 6 by default).
- **Topics and search:** one-tap topic groups (Board games, Socializing, Crafts & STEM, and others) plus free-text search.
- **Filters:** cost, indoor or outdoor, drop-in or registration, hide full events, and distance from your location or a typed place.
- **Programs:** classes and lessons read from the City of Waterloo program guide and the Township of Wellesley programs page, plus a live web search for other providers.
- **Saved events** kept on the phone, with export, import and Add to Calendar.
- **Season alerts:** a phone notification when a new program guide season appears.

## Accuracy rules

These rules shape every part of the code:

- Every event and program links to its source. Nothing is invented or filled in.
- Top-level fields hold what the source stated. Anything the app works out itself (region, converted dates, "time not listed") is stored under `derived`, with a reason in `derived.notes`.
- If a source doesn't state an age, the app shows "Age not listed." Ages are read only from the source's own words.
- Placeholder times (00:00, or 00:00 to 23:59) are shown as "time not listed," not as real times.
- Each item shows when it was last checked.
- Web search results are labelled as not checked by Grand Calendar.

## Sources

| Source | How it's read | Where |
|---|---|---|
| Waterloo Public Library events | iCal feed, hourly; event pages for registration status | GitHub job |
| Explore Waterloo Region events | iCal feed, read on the phone (it blocks GitHub's servers) | Phone |
| City of Waterloo program guide | PDF, checked daily, read again only when the file changes | GitHub job |
| Township of Wellesley programs | Programs web page, checked daily | GitHub job |
| Web search for other providers | Tavily, through your own Cloudflare Worker | Phone, on request |

**Not read automatically,** shown as links instead:

- Kitchener Public Library, and the Kitchener, Waterloo, Wilmot, Woolwich, North Dumfries and Stratford municipal calendars. These block automated requests.
- Program registration on ActiveNet (Kitchener, Wilmot, Wellesley, Woolwich). Its terms don't allow automated access.
- Eventbrite, Meetup and Luma. There's no free search access for these. A Meetup API test is included but not yet set up.
- Visit Stratford. Its robots.txt disallows all automated access.

## How it fits together

```
GitHub Actions (hourly)                     Phone (GitHub Pages app)
  gather.mjs         -> events.json  ----->  app.mjs reads events.json
  gather-programs.mjs -> programs.json ---->  and programs.json, and reads
                      -> guides.json          Explore Waterloo directly
  notify.mjs  -> push alert to the phone
                                              Search the web -> your Cloudflare
                                              Worker (worker.js) -> Tavily
```

### Files

All files sit at the repo root except the workflow.

**App (runs on the phone)**
- `index.html`, `app.css`, `app.mjs`: the screens and their logic.
- `sw.js`: service worker that shows season alerts.
- `manifest.webmanifest`, `icon.svg`, `icon-*.png`: Home Screen app details.
- `atkinson-regular.woff2`, `atkinson-bold.woff2`: the Atkinson Hyperlegible typeface (licence in `atkinson-OFL.txt`).

**Shared rules (used by both the app and the job)**
- `core.mjs`: text decoding, region by address, placeholder-time rules.
- `ages.mjs`: reads stated ages ("ages 4 to 6", "19+", "birth to 18 months").
- `ical.mjs`: iCal parsing and normalising.
- `ew-reader.mjs`: reads Explore Waterloo's feed on the phone.
- `suitability.mjs`: adults-only hiding, soft notes (alcohol, late start, caregiver), cost, indoor or outdoor.
- `topics.mjs`: topic groups and search.
- `merge.mjs`: merges duplicate listings.

**GitHub job**
- `.github/workflows/refresh.yml`: runs every hour at 17 minutes past, and when you tap Run workflow.
- `gather.mjs`: library events and their registration status.
- `gather-programs.mjs`, `guide-waterloo.mjs`, `guide-wellesley.mjs`: programs.
- `notify.mjs`: season alerts.
- `meetup-probe.mjs`: Meetup API test, manual runs only.

**Data the job writes** (don't edit by hand)
- `events.json`, `programs.json`, `guides.json`, `notify-state.json`, and `meetup-probe.json` when the test has run.

**Data kept in the repo**
- `venues.json`: coordinates for Explore Waterloo venues, looked up once with OpenStreetMap.

**Web search helper**
- `worker.js`: paste this into a Cloudflare Worker. It isn't used from the repo itself.

**Tests**
- `test-ages.mjs`, `test-gather.mjs`, `test-rules.mjs`, `test-guide.mjs`, with saved copies of real source data (`*-sample.*`, `wpl-page-*.html`).

## Setup

### GitHub Pages
In the repo, go to Settings, then Pages, and deploy from the `main` branch, root folder.

### GitHub secrets
Add these under Settings, then Secrets and variables, then Actions:

| Secret | What it's for |
|---|---|
| `PUSH_CONFIG` | Season alerts. Copy the code from the app: open it from the Home Screen, then go to Settings and tap Turn on alerts. |
| `MEETUP_CLIENT_KEY`, `MEETUP_MEMBER_ID`, `MEETUP_SIGNING_KEY_ID`, `MEETUP_PRIVATE_KEY` | Optional Meetup test (not yet set up). |

To check alerts, run the workflow with "Send a test alert to your phone" ticked.

### Web search helper (Cloudflare Worker)
1. Create a Worker and paste in `worker.js`.
2. Under the running Worker's **Variables and Secrets**, add a secret named `TAVILY_KEY`. Don't use the box in the Build section, which the running Worker can't see.
3. Optional but recommended: add a KV namespace binding named `USAGE`. This turns on a monthly cap (1,400 searches by default, under Tavily's free credits). Set a `MONTHLY_CAP` variable to change it.
4. In the app, go to Settings, then Live search, paste the Worker address, and tap Test helper.

The app calls the Worker at `/search` and `/health`. If the Worker is connected to this GitHub repo, Cloudflare also serves the repo's files from it (the app's `index.html` at `/`), which is why searches don't use the bare address.

Each tap of Search the web uses 3 credits, and Search more places uses 4. Repeating a search within a day uses none.

## Running the tests

With Node 20 or later, from the repo folder:

```
node test-ages.mjs
node test-gather.mjs
node test-rules.mjs
node test-guide.mjs
```

The workflow runs these before every gather. If any fail, nothing is published and the previous data stays in place.

## Maintenance notes

- **Paused schedules.** GitHub disables scheduled workflows in a public repo after 60 days with no activity. The app shows "the hourly update may be paused" when the data is more than 3 hours old. Re-enable the workflow in the Actions tab.
- **Program guide layout changes.** If a new guide reads as almost empty, the job keeps the previous programs and records an error in `guides.json`. The guide readers then need updating.
- **Places in the area.** The list of town and village names that count as in the area is in `core.mjs` (`IN_REGION`).
- **Topic words.** Each topic's word list is in `topics.mjs`.
- **Polite requests.** The job identifies itself as GrandCalendar, checks the library's robots.txt before reading its feed, and pauses between page requests. Explore Waterloo is read from the phone, at most every 6 hours.

## Privacy

- Your location stays on your phone, rounded to about 1 km. It's never sent to the job.
- Saved events, settings and the alert code live in the phone's storage. Removing the Home Screen app deletes them, so use Export saved now and then.
- No child data is collected. Kids mode is a setting, not a profile.

## Credits and licences

- Event and program details belong to their sources: Explore Waterloo Region, Waterloo Public Library, the City of Waterloo and the Township of Wellesley. Every item links back to its source.
- Venue locations © OpenStreetMap contributors (ODbL).
- Atkinson Hyperlegible typeface by the Braille Institute, SIL Open Font Licence (`atkinson-OFL.txt`).
- Web search by Tavily, through a user-owned Cloudflare Worker.
