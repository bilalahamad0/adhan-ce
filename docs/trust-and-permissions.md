# Trust, permissions & the "not trusted" warning

Context for three issues reported against the published Chrome build (v2.0.0):

1. Full-screen prayer-focus overlay stayed pinned past the auto-resume window.
2. Toolbar icon disappeared (extension had been auto-disabled).
3. `chrome://extensions` shows **"This extension is not trusted by Enhanced Safe Browsing."**

---

## 1. Overlay stuck after Isha — fixed in code

**Root cause.** There were two ways a pause could end and both could fail at once:

- **Background** `ALARM_RESUME` → `handleAutoResume()`. An MV3 service worker can be
  evicted and the alarm dropped; and if the extension is *disabled* (issue 2, which
  happened around the same time) the worker never restarts and the alarm never fires.
- **Content-script self-heal** in `content.js` `tick()`. It was gated on
  `state.settings.autoResumeMinutes != null && state.paused.since` — so a tab that
  never received settings (`state.settings === null`) or a `since`-less pause never
  self-resumed. And `tick()`'s dead-context guard returns *before* the self-heal, so
  once the extension is disabled only `teardown()` (driven by the 1-second
  `setInterval`) can remove the overlay — and Chrome throttles/freezes that interval
  on hidden or discarded tabs. There was **no wall-clock fallback**.

**Fixes (`content.js`):**

- Self-heal now falls back to a **default 5-minute window measured from when the tab
  first observed the pause** (`pauseObservedAt`) when settings/`since` are missing, so
  every tab resumes on its own. The "Auto-resumes in m:ss" countdown uses the same
  effective values, so it shows even before settings sync.
- Added a **wall-clock backstop** (`setTimeout`) armed off the same due time. It
  force-clears the overlay + resumes media independently of `chrome.*` and of the
  `setInterval` tick, tolerating a dead extension context.
- `teardown()` now also **clears the backstop and detaches the capture-phase
  wheel/touchmove/keydown blockers**, so an orphaned instance can't keep suppressing
  input after the overlay is gone.
- `visibilitychange` now runs a full `tick()` (was `render()` only), so a
  re-focused tab immediately re-checks context / self-heal / teardown.

Covered by new tests in `tests/content.test.js` (settings-missing self-heal;
dead-context teardown unlocks scroll).

## 2. Toolbar icon gone — expected, self-resolved

Chrome auto-**disabled** the extension pending permission re-approval ("The newest
version has been disabled because it requires more permissions"). A disabled extension
is hidden from the toolbar; **Re-enable** restores it (as the user confirmed).

The dialog listed *"Read and change all your data on all websites"* (broad host
access) and *"Display notifications"* (the `notifications` permission). This
**disable-on-update fires only on a privilege increase** — when the new version
produces a permission *warning message* the user hadn't already accepted. Practical
consequences (verified against Chrome's docs):

- Bumping the version with an **unchanged** permission-warning set never re-triggers it.
- Swapping the retired `adhan-api-mauve.vercel.app` host for `api.aladhan.com` under the
  existing all-URLs grant does **not** re-trigger it — a specific host collapses under
  "all your data on all websites," and removing a host is a privilege *decrease*.
- To avoid it going forward: never add a permission with a *new* warning to the required
  set; ship such additions as `optional_permissions` / `optional_host_permissions`
  (optional additions never disable). Test updates from a profile that had the **old**
  store version installed, not a fresh install.

## 3. "Not trusted by Enhanced Safe Browsing" — not a code bug

This is **not something a manifest or code change fixes.** Verified against Google/Chrome
Web Store docs and the Chromium extensions group:

- **What "trusted" means (official):** an extension is trusted when *"they're built by a
  developer who follows the Chrome Web Store Developer Program Policies. For new
  developers, it generally takes a few months to become trusted."* No button, form,
  fee, or verification step grants it.
- **It's time + clean compliance, per item.** Community reports (2–6 months) and Chrome
  DevRel confirm it's a time-based reputation signal you can't self-serve. It's judged
  **per extension**, so a brand-new item on an old, trusted account can still be flagged
  — a fresh publish restarts the clock. A policy strike/rejection resets the accrual.
- **Who sees it:** only users who have **manually turned on Enhanced Safe Browsing**
  (`chrome://settings/security`). Users on Standard protection — the large majority —
  never see this specific banner. ~75% of Web Store extensions are already "trusted."

**So the honest answer to "fix so other users don't get this":** for a policy-compliant
item you can't remove it directly; it clears on its own after a few months of clean
compliance. What actually helps (indirectly, by keeping the compliance record spotless
and shrinking the review surface):

- Keep 2-Step Verification on the developer account (already required to publish).
- Verify the publisher email/domain (CWS dashboard + Search Console).
- Keep the permission set minimal and each **per-permission justification** accurate.
- Ship MV3 with **zero remotely hosted code** (already true here).
- Ensure the privacy policy, dashboard Data-Usage disclosures, and actual behavior all
  match. Avoid rejections — each one damages the reputation signal.
- Set expectations in the store description rather than chasing a nonexistent toggle.

---

## Permission posture

**Done — dropped the redundant `tabs` permission.** `chrome.tabs.query({url})` and
`chrome.tabs.sendMessage` work without it because the broad `host_permissions` already
grant tab-URL access, and the code never reads sensitive tab fields (only `t.id`).
Removing it is a privilege *decrease* (no re-enable prompt) and doesn't change any
user-visible warning (the "tabs" warning was already collapsed under all-URLs). Required
set is now `storage, alarms, notifications, scripting`.

**Still broad, and genuinely required:** pausing media in *every* tab at a scheduled,
non-gesture moment fundamentally needs all-sites reach. `activeTab` (active tab, on user
gesture only), `declarativeContent`, and `user_scripts` cannot substitute. The reach
comes from the static `content_scripts` (`http://*/*`, `https://*/*`) plus
`host_permissions` for `scripting.executeScript` into already-open tabs, and
`https://api.aladhan.com/*` for the schedule fetch.

**Per-permission justification (for the CWS dashboard):**

| Permission | Why | Warning? |
|---|---|---|
| `storage` | Settings, schedule cache, local activity counters | none |
| `alarms` | Fire the pause + arm auto-resume at prayer time | none |
| `notifications` | The prayer-time toast | "Display notifications" |
| `scripting` | Inject the pause/overlay into tabs open before load/update | none |
| `host_permissions` all-URLs + content_scripts | Pause `<video>/<audio>` and show the overlay on any site | "Read and change all your data on all websites" |
| `host_permissions` `api.aladhan.com` | Fetch the prayer schedule from the service worker | (collapsed under all-URLs) |

### Optional: soften the install prompt (a product decision, not yet done)

The broad grant can be moved out of the install-time warning by putting
`http://*/*`,`https://*/*` in **`optional_host_permissions`**, removing the static broad
`content_scripts`, and requesting access at a one-time onboarding click
(`chrome.permissions.request({origins:[...]})`) followed by
`chrome.scripting.registerContentScripts` + `executeScript` into already-open tabs.

- **Pro:** removes the install-time / update-time "read and change all your data on all
  sites" warning; the grant persists across restarts; better review framing.
- **Con:** the core feature is **off by default** until the user grants access; requires
  new onboarding UI + injection code; and it does **not** by itself clear the ESB
  "not trusted" badge (that's time-based) nor is it guaranteed to shorten the broad-host
  in-depth review (MV3 gives no way to signal "optional-only" to reviewers).

This changes the product's out-of-box behavior, so it's left as a decision rather than
applied. The current static-broad design is the simplest and most reliable ("pauses
every tab with zero setup") at the cost of the scarier prompt — a defensible trade-off
for a media-pause extension.
