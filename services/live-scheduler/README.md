# live-scheduler

Schedules a batch of YouTube live streams from one file: title, description,
start/end time, thumbnail and stream key for each. Built for Navaratri sevas,
reusable for any event. A local CLI with no dependencies; nothing is deployed.

```
cd services/live-scheduler
cp .env.example .env                       # then put oauth-client.json next to it
npm run yt login                           # sign in by code
npm run yt plan  navaratri.json            # check everything, change nothing
npm run yt apply navaratri.json --yes      # schedule
```

## Who can sign in

**An API key cannot schedule anything.** Every live call answers 401 "API
keys are not supported by this API". It needs a Google sign-in from an
account that can act *as* the channel:

| Access | Works? |
|---|---|
| Channel owner | yes |
| **Brand Account** Owner or Manager (myaccount.google.com/brandaccounts lists the channel) | yes |
| YouTube Studio permission only (Settings → Permissions: Editor, Manager…) | **no**: the API ignores these, and the sign-in reaches only that person's own channel |

The last row was tested on 2026-10-06. A Studio editor's login landed on
their personal channel, `@templedevalayam`.

`login` prints a code for **google.com/device**, so the person approving can
do it from their phone. Google asks which channel to act for, so pick the
temple's. Every write first checks the signed-in channel against
`EXPECTED_CHANNEL_ID` and refuses on a mismatch. `whoami` shows it.

Google Cloud setup (once): project `teak-mix-489419-v1`, YouTube Data API v3
enabled, OAuth client of type **TVs and Limited Input devices**. The consent
screen is *Internal*, so only uskfoundation.or.ke accounts can sign in. For
anyone else, Google Auth Platform → Audience → **Make external** → **Publish
app**. Leave it on Testing and the token dies after 7 days.

## The schedule file

See `schedule.example.json`. Times are the temple's wall clock in
`timezone`; DST is handled. An `end` at or before `start` means past midnight.

- `stream`: title of the stream key every broadcast is bound to. `streams`
  lists them, and `create-stream "<title>"` makes one. The key itself is
  written to `data/`, never printed: whoever has it can broadcast as the
  channel.
- `thumbnails`: folder, relative to the schedule file. JPG/PNG, ≤2 MB,
  1280×720 ideal. Custom thumbnails need a verified channel.
- `id` per event: optional but recommended. It is what makes a re-run
  *update* an event (new time, fixed typo) rather than create a second one.
  Without it the key is `date start`.
- `autoStart`/`autoStop` (default true): the broadcast goes live when the
  encoder starts sending to the bound key, and ends when it stops.

`plan` validates everything first (lengths, `<`/`>` which YouTube rejects,
past times, thumbnail size, missing files) and sends nothing if any event is
wrong.

## Re-running is safe

`data/ledger/<schedule>.json` records each event's broadcast id and which
steps finished (created, updated, bound, thumbnail). `apply` does only what
is unfinished or changed. An upcoming broadcast with the same title at the
same minute is adopted rather than duplicated, which covers a crash between
insert and ledger write and a seva someone scheduled by hand. A broadcast
that is no longer upcoming (live, ended, deleted) is left alone. On
`quotaExceeded`, apply stops and resumes on the next run.

`test [--thumb file]` creates a **private** broadcast two days out, sets the
thumbnail, reads it back and deletes it. Run it once after a new sign-in.

## Not yet verified

Nothing has written to the target channel: no sign-in that reaches it exists
yet. Untested against it: insert, bind, thumbnails.set, and whether
auto-start picks the right broadcast when several are bound to one key.
Watch the first seva.
