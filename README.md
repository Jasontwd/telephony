# Formtech contact and phone service

First working version of Formtech's public enquiry form, staff call/enquiry workspace and keypad phone router. **HubSpot remains the support ticket system, including the existing support@ mailbox.**

## What is implemented

- Public form for sales, support, orders, accounts and general enquiries, with store preference.
- Separate staff logins; managers can see all queues, agents cannot see accounts, accounts staff see only accounts.
- Assignments, callback tasks, next actions, due dates, sales outcomes, quote values and an audit trail.
- Twilio voice webhooks: press 1 Auckland, 2 Christchurch, 3 support, 4 orders, 5 accounts.
- NZ local business hours, configurable closure dates, one backup destination per route, answer confirmation, shared voicemail and call metadata.
- Durable HubSpot ticket handoff for every active enquiry queue and channel (sales, general, orders, accounts and support). A unique HubSpot reference property prevents duplicate tickets after timeouts.
- Optional signed email ingestion bridge for orders@ and accounts@. support@ is deliberately excluded.
- Tests, Docker image, Fly configuration and GitHub deployment workflow.

**Nothing is live merely by pushing this repository.** No number has been purchased, no existing mailbox or website has been changed, and no real customer record has been created during development.

## Architecture and limits

Node.js 24, server-rendered HTML and SQLite on one persistent Fly Volume. There are no third-party runtime packages. The initial service must run on **one Machine**: Fly Volumes are not shared databases. Do not scale horizontally. Move to PostgreSQL before adding multiple application Machines. This trades high availability for a small initial deployment; a machine/volume outage interrupts service until restored.

The dashboard is a call/enquiry workspace, not a second support desk. HubSpot owns support replies, ticket status and support ownership. Local support status and notes are for call follow-up only and are not synced back to HubSpot. The initial integration creates a ticket with customer details in its description; it does not automatically associate or create contacts, import existing tickets, sync HubSpot status, or create HubSpot sales deals. Phone enquiry handoff waits for five minutes without new call events so voicemail information can settle. Later recording changes remain visible in the linked local call record.

The email bridge is an API contract, not an installed Microsoft 365/Google Workspace connector. It does not send replies or ingest attachments. Voicemail is played from the authenticated Twilio console; recording IDs are visible only to authorised staff. Calls themselves are not recorded. Outbound business-caller-ID calling, SMS, notifications, attachment upload, pagination and advanced performance reports are not part of this first version.

## Run locally

Install Node.js 24 or newer. Copy `.env.example` to `.env`, configure staff users, then:

```sh
node --env-file=.env server.js
npm test
```

Open `http://localhost:8080`. In development only, omitting SESSION_SECRET creates a temporary secret and invalidates sessions on restart. Production refuses to start without a strong secret, HTTPS base URL and a manager login. No default passwords exist.

### Staff users

Generate one user object per staff member. Roles: `manager`, `agent`, `accounts`. Use `jason` and `martin` usernames for automatic store assignment. In Bash, enter a password without displaying it or putting it in shell history:

```sh
read -r -s -p 'New password: ' staff_password
printf '%s' "$staff_password" | node scripts/create-user.js jason manager
unset staff_password
```

The output contains a salted scrypt hash, not a plaintext password. Combine the objects into a JSON array and set `STAFF_USERS_JSON` as a secret. Do not commit the JSON or hashes. Use a password manager for staff passwords. Removing a user from configuration invalidates their existing sessions on restart. Sessions expire after eight hours. For immediate password-change session revocation, rotate SESSION_SECRET too.

### First manager setup without a terminal

Download `tools/create-staff-login.html` and open it locally in your browser. It works offline with bundled scrypt-js 3.0.1 and makes no network requests. Choose and confirm a password for `jason` (manager), then copy the generated JSON into the Fly secret `STAFF_USERS_JSON`. Save the password in your password manager. This helper is for initial setup: replacing the secret replaces the complete staff list. The helper uses the same UTF-8 encoding, salt representation and scrypt parameters as the server. No plaintext password is included in the JSON.

## Deploy to Fly.io

Formtech has created the Fly app `telephony-kidzwq`. This project has not verified its Machine, volume or runtime secrets. Perform these steps in a terminal authenticated to the intended Fly organisation. Install [flyctl](https://fly.io/docs/flyctl/install/) first.

1. Clone the repo and check out the implementation branch (or main after merging).
2. Run `fly auth login`, then `fly status -a telephony-kidzwq` to verify access to the existing app. Do not create another app.
3. Check `fly volumes list -a telephony-kidzwq` for an existing `formtech_data_v2` volume in Sydney first. If absent, create it: `fly volumes create formtech_data_v2 --region syd --size 1 -a telephony-kidzwq`.
4. Set secrets using `fly secrets import -a telephony-kidzwq < /secure/path/formtech-secrets.env`. Keep that file outside Git, restrict its permissions, and delete it securely when no longer needed. The app requires PUBLIC_BASE_URL (already set to https://telephony-kidzwq.fly.dev in fly.toml), SESSION_SECRET and STAFF_USERS_JSON. Use the `.env.example` keys as a checklist. Leave TELEPHONY_ENABLED=false until the provider is ready.
5. Deploy with `fly deploy --ha=false`. Verify exactly one Machine with `fly status`, and that its volume is mounted at `/data`. The container starts as root to permit writing the provisioned volume; do not mount other sensitive volumes.
6. Verify `/health`, a staff login and a test form submission. Restart the Machine and confirm the enquiry persists.
7. Create an app-scoped deploy token: `fly tokens create deploy -a telephony-kidzwq`. Store its output as the GitHub Actions repository secret `FLY_API_TOKEN`—never in a commit, issue or chat.
8. Set GitHub Actions repository variable `FLY_DEPLOY_ENABLED` to `true` only once the app, volume and secrets exist. The deployment workflow tests before deploying main. It can also be run manually. Until this variable is set, deployments are skipped.

The supplied Fly config selects Sydney and keeps a Machine running to avoid phone webhook cold starts. Resources and calls incur provider charges. No resources have been created by the supplied CI until deployment is enabled.

### Initial deployment recovery (15 September 2026)

The original Sydney volume `vol_r68wy28zo3kdp9j4` could not accommodate a Machine on its host. The recovery workflow preserved it and forked it to `formtech_data_v2` (`vol_vxmgzk8j2gon2xw4`) in another Sydney hardware zone. The Fly config now targets that fork. A shared public IPv4 was allocated explicitly after automatic IPv6 allocation failed. No original volume was deleted.

`.github/workflows/fly-recovery.yml` is now manual-only and refuses to run recovery when app Machines exist. It is a record of this initial recovery, not a general database migration tool. `STAFF_USERS_JSON` was still missing when recovery completed; configure it before deployment.

### Backups and recovery

Configure Fly Volume snapshots and review their retention in your account. Snapshots alone are not the full recovery plan. Run `npm run backup -- /data/formtech-backup.sqlite` inside the Machine to make a consistent SQLite backup and copy it to secure off-machine storage; use a new destination filename each time. Arrange a daily scheduled backup/export with your hosting administrator before production. **This repository does not yet automate off-machine backup delivery.** Test restoring a copy before switching the public phone number.

For recovery: stop the app, preserve the damaged volume, restore a verified backup onto a replacement volume and point a single Machine at it. Do not copy a live SQLite file without using the backup script. User sessions are included in backups; rotate SESSION_SECRET after a restore.

## Connect the phone number

Use a Twilio voice-capable NZ business number, subject to number availability and account requirements. This implementation uses Twilio Programmable Voice, not a generic 2talk connection. Buy/verify a number in the intended provider account separately.

Set these Fly secrets:

| Secret | Meaning |
| --- | --- |
| TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN | Provider account credentials |
| PUBLIC_PHONE | New public Formtech number, E.164 format |
| AUCKLAND_PHONE | Martin's destination in E.164 format |
| CHRISTCHURCH_PHONE | Jason's destination in E.164 format |
| SUPPORT_PHONE / ORDERS_PHONE / ACCOUNTS_PHONE | Nominated department staff destinations |
| `*_BACKUP_PHONE` | Optional backup for each route |
| HOURS_CONFIRMED | `true` after reviewing hours and closures |
| CLOSED_DATES | Comma-separated NZ local closure dates, including public holidays |
| TELEPHONY_ENABLED | Set `true` after all required configuration is present |

Convert NZ mobile numbers to E.164 by replacing the leading `0` with `+64`. Destination numbers are never embedded in public HTML. Empty department destinations go to voicemail. Assign responsibility for general and department callbacks in the staff queue before launch.

Configure the purchased number:

| Setting | URL / method |
| --- | --- |
| A call comes in | `https://telephony-kidzwq.fly.dev/voice/incoming` — POST |
| Call status changes | `https://telephony-kidzwq.fly.dev/voice/status` — POST |

Other action, confirmation and recording callbacks are generated in the voice responses. PUBLIC_BASE_URL must exactly match the public webhook origin for signature validation. Do not put an extra URL rewrite in front of these endpoints. All webhook fields are included in HMAC validation; unsigned requests are rejected. A configured destination cannot be overridden by caller input.

Staff must press 1 to accept a forwarded call, preventing personal voicemail from taking it. Unanswered calls try the configured backup once while that route is open, then offer voicemail. Backup destinations use the route's hours—configure a suitable backup, rather than relying on another store's different opening hours. No or invalid keypad selection gets one replay, then voicemail. Configure a provider-side fallback for app outages independently before launch.

Enable protected recording media in Twilio. The voicemail greeting discloses recording. Set your organisation's recording and enquiry retention periods in the provider and operating procedures before taking customer data.

### Business hours

Defaults are based on the published store hours and must be confirmed: Auckland weekdays 09:00–17:00 and Saturday 11:00–15:00; Christchurch weekdays 10:00–17:00. Department queues default to weekdays 09:00–17:00. All use Pacific/Auckland, including daylight saving. CLOSED_DATES overrides every route. Public holidays are **not** calculated automatically.

HOURS_JSON can replace all hours, with keys `auckland`, `christchurch`, `general`, weekday keys 0–6 (Sunday=0), and `["HH:MM","HH:MM"]` ranges. Missing weekdays are closed. For example:

```json
{"auckland":{"1":["09:00","17:00"]},"christchurch":{"1":["10:00","17:00"]},"general":{"1":["09:00","17:00"]}}
```

That example opens Mondays only; do not use it as the full week schedule.

## HubSpot ticket handoff

Keep support@ connected to the existing HubSpot help desk. Do not forward it into this app. Set up a HubSpot private app credential for the intended existing support portal, with tickets read/write and ticket-property read permission. Store it only as `HUBSPOT_ACCESS_TOKEN` in Fly secrets; the ChatGPT HubSpot connection is not a runtime credential.

Set HUBSPOT_PORTAL_ID, HUBSPOT_TICKET_PIPELINE and HUBSPOT_TICKET_STAGE. The connected portal exposed pipeline `0` (Support Pipeline) and stage `1` (New), but verify this is the portal currently handling support@ before using those IDs. No portal ID or private credentials are committed here.

Create a **unique-value string ticket property** named `formtech_reference` (or set HUBSPOT_REFERENCE_PROPERTY to your equivalent). The app checks `hasUniqueValue` before creating tickets and refuses to create them without that guarantee. If your HubSpot plan does not permit this property, the handoff needs an alternative idempotency design before enabling it. An existing ticket is looked up by that property before any create attempt. Failed deliveries remain visible and retry roughly every minute. No test ticket is created automatically at startup.

When the integration is absent, all submissions are stored locally and visibly marked as awaiting handoff. Staff must monitor these queues; there is no external failure alert yet. Once handed over, open the ticket link for support work. The local dashboard never treats its status as HubSpot's ticket status.

References: [HubSpot tickets API](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/tickets/guide), [Twilio webhook security](https://www.twilio.com/docs/usage/security), [Fly GitHub deployment](https://fly.io/docs/launch/continuous-deployment-with-github-actions/).

## Optional orders/accounts email bridge

Your chosen mail provider or automation must POST JSON to `/hooks/email`:

```json
{"id":"provider-stable-message-id","to":"orders@formtech.co.nz","from":"customer@example.com","subject":"Order question","text":"Message body"}
```

Sign the exact UTF-8 body using HMAC-SHA256 with EMAIL_WEBHOOK_SECRET: `timestamp + "." + rawBody`. Send the lowercase hex digest as `X-Formtech-Signature`, and Unix seconds as `X-Formtech-Timestamp`. Requests older than five minutes are rejected. A stable message ID deduplicates retries. The provider adapter must verify recipient addresses and authenticity; do not expose the signing secret to browsers. Emails sent to support@ return `handledBy: hubspot` without creating a local record. Thread grouping and attachment processing are not implemented.

## Before replacing Jason's public number

Complete real-provider acceptance tests for all five selections, opening/closing boundaries, public holidays, rejected mobile answers, no answer, busy, voicemail, retry delivery, a backup, caller hang-up before selection, and app outage fallback. Confirm the correct HubSpot ticket and callback owner are produced. Verify backups and monitoring. Local automated tests use signed simulated requests; they do not prove live provider connectivity.

Only then replace personal contact numbers in the Formtech website header, showroom/contact blocks and public listings. Keep the existing number active during transition. This project has not changed formtech.co.nz.

### Credential types

This service requires the Twilio Account SID (AC followed by 32 hexadecimal characters) and that account's Auth Token. An OAuth client ID is not a substitute. Store credentials in Fly runtime secrets; do not put them in GitHub source or chat. The GitHub Actions secret FLY_API_TOKEN is a separate, app-scoped Fly deployment token.

## Formtech branding and Shopify page embed

The app uses the supplied Formtech logo, its blue background, and the website orange
accent `#FB7C33`. `/formtech-logo.png` is a locally served asset; no third-party image
host is needed. The public contact number is displayed as `09 870 0642`.

To embed the enquiry form into a Shopify page:

1. In the theme editor, create or select a page template for the contact page.
2. Add a **Custom liquid** section. Paste the complete contents of
   `templates/shopify-contact-embed.liquid` and save.
3. If using a new template, assign it to the intended page. Check the published
   page on desktop and mobile, then send one clearly labelled support test.

The snippet uses `/embed`, automatically adjusts the iframe height, and includes
an ordinary link as a fallback. Paste into Custom liquid, not the rich-text editor,
which may strip scripts. Do not add an iframe sandbox attribute without testing:
it can change the request origin and prevent submissions.

Only `https://formtech.co.nz` and `https://www.formtech.co.nz` (plus same-origin)
may frame the public embed endpoints. Shopify admin/theme previews or a
`myshopify.com` hostname may not render it; verify on the published custom-domain
page. Add any additional exact trusted origin deliberately in the CSP and
`static/embed.js`; do not allow all Shopify stores or arbitrary origins.

The embed uses a one-hour, purpose-bound signed form token and a strict same-origin
POST check, independent of cookies. It never uses staff authentication. Existing
staff and normal public-page CSRF protections are unchanged. Staff pages retain
`frame-ancestors 'none'`. Rate limits, validation, duplicate-submit prevention,
queue routing and HubSpot handoff are shared with the ordinary contact form.
Errors and success pages retain the embed layout and framing policy.

The form requires an email or phone number. No attachments or conversation
recording are added by the embed. Test privacy links, keyboard navigation, height
resizing and success/error views before replacing the existing Shopify contact form.


### Add Martin while preserving the manager login

Open `tools/create-martin-login.html` locally, choose and confirm Martin's password,
and save it privately. The offline helper outputs an Agent account named `martin`.
Save its complete output as the new Fly secret `STAFF_AGENT_USERS_JSON` and deploy.
Keep `STAFF_USERS_JSON` unchanged. The additional setting accepts only Agent accounts;
all usernames across both settings must be unique. If the additional secret already
exists, preserve the other entries rather than replacing the whole list.
Martin signs in at `/login`; accounts enquiries remain inaccessible. Auckland
enquiries can now be assigned automatically to his `martin` username.
Removing an account requires removing it from its corresponding secret and deploying.

## Daily call email

The Fly app checks once per minute for a report due at **08:00 Pacific/Auckland**, addressed to **jason@formtech.co.nz**. The report covers phone enquiries logged in the exact preceding 24 hours, with totals, departments, answered/unanswered calls, voicemails and pending callbacks for those calls. It links to protected staff records and sends a zero-call report on quiet days. Email details are limited to the first 100 calls; totals include all calls. Outcomes reflect the database when the report is prepared, not conversation transcripts.

To activate delivery:
1. Verify a sending domain in [Resend](https://resend.com/docs/dashboard/domains/introduction), including its required DNS records.
2. Create a sending API key and save it privately in Fly Secrets as `RESEND_API_KEY`.
3. Set `CALL_SUMMARY_FROM` in Fly Secrets to an address on that verified domain, for example `calls@formtech.co.nz`. Do not use this example until domain verification succeeds.
4. Deploy the secrets. `CALL_SUMMARY_ENABLED=true`, `CALL_SUMMARY_TO=jason@formtech.co.nz` and `CALL_SUMMARY_HOUR=8` are already in fly.toml. A Fly secret with the same name overrides its configured value.
5. Sign in as a manager and open `/staff/call-summary` to check readiness and preview the previous 24 hours. The first scheduled email runs at the next 8am after activation. No email is sent by viewing the preview.

A persistent SQLite job prevents repeat sends after a restart. A frozen payload and Resend idempotency key protect retries after uncertain network results. Retries stop after 23 hours and mark the job `needs_review`; check Resend before any manual resend. `accepted` means accepted by Resend, not confirmed inbox delivery; inspect delivery/bounce events in Resend. Keep the Fly machine running (the existing configuration does). A restart catches up the current day's due report; whole missed days are not backfilled. Because the window is exactly 24 hours, the two NZ daylight-saving change days can overlap or omit one hour relative to the preceding daily report. Disable with `CALL_SUMMARY_ENABLED=false`.

Sender credentials are required: deployment alone does not activate outgoing email. Email carries caller numbers to the configured recipient; no recordings or message contents are included. Only managers can view the report because it includes all departments, including accounts.

All non-deleted local enquiries without a HubSpot ticket are eligible, including existing backlog and resolved/waiting records. The worker runs every 30 seconds in batches of 10. Phone records wait five minutes after their last update; website and ingested email records do not. All queues use the configured ticket pipeline/stage (currently Support Pipeline / New); the ticket description includes the originating queue, store and local owner. The local owner is descriptive only, not an automatic HubSpot owner assignment. Existing HubSpot links and deleted records are excluded. HubSpot permissions govern visibility of tickets there, including Accounts tickets; local queue restrictions remain unchanged.


## HubSpot progress back to the app
The worker checks up to 50 linked, non-deleted, non-archived enquiries each cycle, with at least 60 seconds between checks per record (normally 60–90 seconds). A ticket with a nonempty valid owner ID and a stage different from the configured initial New stage, in the configured pipeline, causes the local enquiry to be archived. Both conditions are required. Missing tickets, missing fields, other pipelines and API failures leave the record active and show a retry message where appropriate. No HubSpot record is modified or deleted.

Archived enquiries are removed from active lists and counters and retained under Archived with existing queue access restrictions and audit history. Their calls remain in daily call totals, but are no longer counted as outstanding local callbacks. Archiving is a one-way handoff; subsequent HubSpot reopening does not automatically restore the local enquiry. Local next-step editing is disabled once archived; continue work in the linked HubSpot ticket. Deleted enquiries remain separate.
