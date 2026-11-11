# Grand Calendar

A free events and programs app for Waterloo Region and Stratford, Ontario, built as a Home Screen web app on GitHub Pages. It gathers events and registered programs from public sources into one list, with filters for adults, families and kids, so you don't have to search each site separately.

Live at: https://casimbahadar.github.io/grand-calendar/

## What it does

- **Events** from Explore Waterloo Region and Waterloo Public Library, merged into one list for today, the weekend, the next two weeks or chosen dates.
- **Who it's for:** Everyone, Family, or Kids (ages set in Settings, 5 to 6 by default).
- **Topics and search:** one-tap topic groups (Board games, Socializing, Crafts & STEM, and others) plus free-text search.
- **Filters:** cost, indoor or outdoor, drop-in or registration, hide full events, and distance from your location or a typed place.
- **Programs:** classes and lessons read from the City of Waterloo program guide and the Township of Wellesley programs page, plus a live web search for other providers. Activity chips, and a one-time-class filter for trying something without committing.
- **Providers:** a tab listing clubs, schools and lessons across nine kinds of activity, checked by hand on each provider's own website. Filter by who it's for, activity and town; cards show matching classes in one line and expand on tap. **Try it first** shows providers whose own site states a free trial, trial class, drop-in or pass, in their words with a link.
- **This weekend, one tap:** a shortcut at the top of Events shows this weekend for the kid ages in Settings, nearest first when a location is set, with a link to programs starting soon.
- **Less effort:** the app remembers your last tab and filter choices, and long link lists fold into one row.
- **Links in Chrome:** a per-phone setting opens outside links in the Chrome app on iPhone (off by default, so others keep their own browser).
- **Fast and offline:** the app opens with its saved copy of the events and refreshes in the background; with no signal it opens from the copy the service worker keeps.
- **Your calendar:** a Calendar tab showing only what you saved, as a month grid or a week strip, with the chosen day's items below. Weekly programs appear on every class day the source states. **Add your own** covers things the app can't read, like an ActiveNet registration or private lessons: one day, or chosen weekdays between a first and last date. It can also import a calendar file, or the calendar link from an ActiveNet receipt, with a check-before-adding preview. A List view keeps export, import and Add to Calendar. **Add all to iPhone Calendar** makes one calendar file with every upcoming class day and event, with an optional reminder. A monthly reminder offers a backup of saved items, which live only on the phone.
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
| Communitech (Luma), the Waterloo tech community calendar kept by Builders Club (Luma), Waterloo Region Small Business Centre, Accelerator Centre | Calendar feeds published for subscribing; Luma times converted from UTC; Toronto events hidden | GitHub job |
| City of Waterloo program guide | PDF, checked daily, read again only when the file changes. Preschool, Children's, Youth, Adult and Swim sections | GitHub job |
| Township of Wellesley programs | Programs web page, checked daily | GitHub job |
| Web search for other providers | Tavily, through your own Cloudflare Worker | Phone, on request |

**Not read automatically,** shown as links instead:

- Kitchener Public Library, and the Kitchener, Waterloo, Wilmot, Woolwich, North Dumfries and Stratford municipal calendars. These block automated requests.
- Program registration on ActiveNet (Kitchener, Wilmot, Wellesley, Woolwich, Cambridge) and PerfectMind (Stratford). Their terms don't allow automated access.
- Greater KW Chamber of Commerce and Cambridge Chamber of Commerce events: behind member or ticketing systems, so the app links to their calendars.
- Cambridge's Activities Guide. It's published only as a BlueToad flipbook whose text comes out scrambled (ages and times separate from their classes), so it can't be read reliably. A PDF from the city would fix this.
- Eventbrite, Meetup and Luma. There's no free search access for these. Meetup's API needs a paid Meetup Pro subscription to get a key, so it isn't used. Live search can still find Meetup pages.
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
- `sw.js`: service worker that shows season alerts and keeps a copy of the app and its data for offline use (always fetched fresh when online).
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
- `calendar.mjs`: works out which days each saved item happens on, from stated days only.
- `export-ics.mjs`: builds the "Add all to iPhone Calendar" file (one entry per day, stable IDs, optional reminders).
- `ics-import.mjs`: reads calendar files you import (weekly and daily repeats, skipped dates); patterns it can't read are reported, not guessed.

**GitHub job**
- `.github/workflows/refresh.yml`: runs every hour at 17 minutes past, and when you tap Run workflow.
- `gather.mjs`: library events and their registration status.
- `gather-programs.mjs`, `guide-waterloo.mjs`, `guide-wellesley.mjs`: programs.
- `notify.mjs`: season alerts, and an alert when the monthly provider check flags pages.
- `check-providers.mjs`: once a month, revisits each provider's own page, confirms each recorded age and any trial offer still appear in their words, and flags pages whose stated ages changed. Results go to `provider-checks.json`; flagged cards show "May be out of date".

**Data the job writes** (don't edit by hand)
- `events.json`, `programs.json`, `guides.json`, `notify-state.json`, `provider-checks.json`.

**Data kept in the repo**
- `venues.json`: coordinates for Explore Waterloo venues, looked up once with OpenStreetMap.
- `providers.json`: program providers checked by hand on their own websites, with ages only where they state them and the date checked.

**Web search helper**
- `worker.js`: paste this into a Cloudflare Worker. It isn't used from the repo itself.

**Tests**
- `test-ages.mjs`, `test-gather.mjs`, `test-rules.mjs`, `test-guide.mjs`, `test-calendar.mjs`, `test-import.mjs`, `test-providers.mjs`, `test-export.mjs`, `test-business.mjs`, with saved copies of real source data (`*-sample.*`, `wpl-page-*.html`).

## Setup

### GitHub Pages
In the repo, go to Settings, then Pages, and deploy from the `main` branch, root folder.

### GitHub secrets
Add these under Settings, then Secrets and variables, then Actions:

| Secret | What it's for |
|---|---|
| `PUSH_CONFIG` | Season alerts. Copy the code from the app: open it from the Home Screen, then go to Settings and tap Turn on alerts. |

To check alerts, run the workflow with "Send a test alert to your phone" ticked.

### Web search helper (Cloudflare Worker)
1. Create a Worker and paste in `worker.js`.
2. Under the running Worker's **Variables and Secrets**, add a secret named `TAVILY_KEY`. Don't use the box in the Build section, which the running Worker can't see.
3. Optional but recommended: add a KV namespace binding named `USAGE`. This turns on a monthly cap (1,400 searches by default, under Tavily's free credits). Set a `MONTHLY_CAP` variable to change it.
4. In the app, go to Settings, then Live search, paste the Worker address, and tap Test helper.

The app calls the Worker at `/search`, `/health` and `/ics`. `/ics` fetches the calendar link from an ActiveNet receipt (only active.com and activecommunities.com addresses, nothing stored), because ActiveNet doesn't let the phone fetch it directly. If the Worker is connected to this GitHub repo, Cloudflare also serves the repo's files from it (the app's `index.html` at `/`), which is why searches don't use the bare address.

Each tap of Search the web uses 3 credits, and Search more places uses 4. Repeating a search within a day uses none.

## Running the tests

With Node 20 or later, from the repo folder:

```
node test-ages.mjs
node test-gather.mjs
node test-rules.mjs
node test-guide.mjs
node test-calendar.mjs
node test-import.mjs
node test-providers.mjs
node test-export.mjs
node test-business.mjs
```

The workflow runs these before every gather. If any fail, nothing is published and the previous data stays in place.

## Maintenance notes

- **Schedule timing.** GitHub starts scheduled workflows when it has capacity, so the hourly job often runs every few hours instead. It also disables scheduled workflows in a public repo after 60 days with no activity. The app shows "the scheduled update may be paused" only when the data is more than 12 hours old; then check the Actions tab.
- **Program guide layout changes.** If a new guide reads as almost empty, the job keeps the previous programs and records an error in `guides.json`. The guide readers then need updating.
- **Re-checking a flagged provider.** Read their page again, update the entry in `providers.json`, and set its `checked` date to the day you looked. The flag clears at the next monthly check once that date is after the flag. Entries with a `check` reason (a PDF flyer, a page the checker can't read) are re-checked by hand.
- **Places in the area.** The list of town and village names that count as in the area is in `core.mjs` (`IN_REGION`).
- **Topic words.** Each topic's word list is in `topics.mjs`.
- **Polite requests.** The job identifies itself as GrandCalendar, checks the library's robots.txt before reading its feed, and pauses between page requests. Explore Waterloo is read from the phone, at most every 6 hours.

## Sharing the app

- **Link:** https://casimbahadar.github.io/grand-calendar/ (Settings, Share Grand Calendar opens the phone's share sheet).
- **First visit:** a short welcome asks who it's for (just adults, or kids and their ages). It sets Kids mode and the weekend shortcut and can be changed in Settings. Phones already using the app skip it.
- **What other people get:** everything except two owner-only features, which are in Settings under "For the app's owner":
  - **Season alerts** go only to the owner's phone (its code is in the PUSH_CONFIG secret). Others see new guides in the Programs tab and can add registration dates to their calendar.
  - **Live search** needs the owner's search helper address, so the Programs tab's web search stays hidden on other phones. Typing in the search boxes and all filters work for everyone and use no credits.
- **Privacy:** Settings, About and privacy explains it: saved items, settings and location stay on each phone; no accounts; nothing collected.
- **Adding to a Home Screen:** iPhone (Safari or Chrome): Share, then Add to Home Screen, leaving Open as Web App on. Android (Chrome): ⋮ menu, then Add to Home screen or Install app.

## Accessibility

- Text follows the iPhone's Text Size setting (Settings, Display & Brightness, Text Size, or Accessibility, Larger Text); the default size looks as designed. Well above the default, a larger-text layout switches on: one-line title, selectors as tidy grids, the month name on its own line, stacked buttons and shorter search hints. Checked at four sizes up to a large accessibility size with nothing cut off or running off the screen.
- Checked with the axe accessibility checker on every tab, card and dialog in light and dark mode: no violations (labels, button names, roles, colour contrast).

## Privacy

- Your location stays on your phone, rounded to about 1 km. It's never sent to the job.
- Saved events, settings and the alert code live in the phone's storage. Removing the Home Screen app deletes them, so use Export saved now and then.
- No child data is collected. Kids mode is a setting, not a profile.

## Credits and licences

- Event and program details belong to their sources: Explore Waterloo Region, Waterloo Public Library, the City of Waterloo and the Township of Wellesley. Every item links back to its source.
- Venue locations © OpenStreetMap contributors (ODbL).
- Atkinson Hyperlegible typeface by the Braille Institute, SIL Open Font Licence (`atkinson-OFL.txt`).
- Web search by Tavily, through a user-owned Cloudflare Worker.
