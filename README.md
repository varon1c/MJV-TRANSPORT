# MJV Transport

A multi-page van-rental website backed by a Node.js API and PostgreSQL. The server serves the website, validates form submissions, and stores private applicant documents outside the public web directory.

## Project layout

- `public/` — website pages and browser assets (`css/`, `js/`, and `images/`).
- `server.js` and `src/` — Node.js web server and database connection.
- `db/` — PostgreSQL migrations and seed data.
- `scripts/` — database and administrator commands.
- `tests/` — unit and PostgreSQL integration tests.

The server publishes only `public/`; database files, application code, and private uploads are not served as website files. Page links and assets remain rooted at the site URL, so the home page is `/` and the admin dashboard is `/admin.html`.

## Requirements

- Node.js 20 or later
- PostgreSQL 14 or later

## Local setup

1. Create a PostgreSQL role and database. For example, connect to PostgreSQL as a database administrator and run:

   ```sql
   CREATE ROLE mjv_app LOGIN PASSWORD 'replace-with-a-long-random-password';
   CREATE DATABASE mjv_transport OWNER mjv_app;
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL` to the credentials for that database. Keep `.env` private; it is ignored by Git.

   ```powershell
   Copy-Item .env.example .env
   ```

3. Install dependencies, apply SQL migrations, and seed the three existing fleet listings:

   ```powershell
   npm install
   npm run migrate
   npm run seed
   ```

4. Create an administrator interactively. Password input is hidden; choose a unique password with at least 14 characters:

   ```powershell
   npm run admin:create -- mjvadmin
   ```

5. Start the website and API:

   ```powershell
   npm start
   ```

   Open `http://127.0.0.1:8000`. The protected dashboard is at `/admin.html`.

To change an administrator password and revoke existing sessions:

```powershell
npm run admin:reset-password -- mjvadmin
```

## Database

SQL migrations are stored in `db/migrations/` and tracked in `schema_migrations`. The initial migration creates:

- `vehicles`: fleet inventory, rates, capacity, image paths, and active/availability flags.
- `customers`: normalized customer records with a unique, lower-case email address.
- `bookings`: pending requests tied to a customer and vehicle, with pickup/return timestamps, status, quoted amount, and administrative notes.
- `inquiries`: customer messages and review status.
- `applications`: applicant details, workflow status, and private document references.
- `admin_users` and `admin_sessions`: scrypt password hashes and revocable, expiring admin sessions.
- `audit_log`: administrative changes.

The seed inserts only the existing Manong, Harold, and Jarvis van listings. Rates are left unset rather than invented. Booking requests remain `pending`; availability is checked by the API, and confirmation is an explicit administrator action. Booking creation and confirmation lock the vehicle row in a database transaction before checking overlapping confirmed trips.

## API

- `GET /api/vehicles` — active vehicles available for requests.
- `GET /api/availability?vehicle_id=…&pickup_date=…&pickup_time=…&return_date=…&return_time=…` — checks a trip window against confirmed bookings.
- `POST /api/bookings` — creates a pending booking and returns its reference.
- `POST /api/inquiries` — saves a customer inquiry.
- `POST /api/applications` — saves an application and privately stores validated documents.
- `/api/admin/*` — authenticated dashboard, fleet management, record status updates, and protected application downloads.

Public submissions are validated server-side and rate-limited. Admin API mutations require a same-origin request, an HTTP-only `SameSite=Strict` session cookie, and a CSRF token. Passwords are hashed with Node's scrypt implementation. Queries use PostgreSQL parameters.

## Production and operations

- **Vercel + Render + Neon:** create the Neon database, deploy this repository's Express service on Render, and publish the `public/` directory on Vercel. This app's browser code calls relative `/api/*` URLs, so Vercel must rewrite those paths to the Render service to make forms and the admin work. That rewrite is not configured in this repository; add it in Vercel project configuration (or add a `vercel.json` rewrite) after you know the Render service URL. Set Render's `PUBLIC_ORIGIN` to the exact Vercel production origin, for example `https://your-project.vercel.app` (no path). With the rewrite, browser requests remain same-origin, so no permissive CORS or cross-site session cookies are needed.
- In Render, set the service root to the repository root, build command to `npm ci`, start command to `npm start`, `HOST=0.0.0.0`, `COOKIE_SECURE=true`, `PGSSL=true`, `TRUST_PROXY=1`, and `PUBLIC_ORIGIN` as above. Add `DATABASE_URL` from Neon as a secret. Apply migrations with `npm run migrate` and seed fleet data once with `npm run seed`, both using the Neon connection string; create the admin with `npm run admin:create -- mjvadmin`. Do not commit database credentials.
- In Vercel, import the repository, choose the Other framework preset, set the output directory to `public`, and deploy. Configure the `/api/*` rewrite to `https://<your-render-service>.onrender.com/api/*`; ensure the Vercel admin page and API responses use `private, no-store` cache headers. Preview-domain origins won't match `PUBLIC_ORIGIN`; use the production domain for forms/admin unless you deliberately configure an exact preview origin.
- **Important uploads limitation:** Render's local filesystem is ephemeral. Before accepting applications, attach a persistent Render disk and set `UPLOAD_DIR` to a directory on its mount path, then verify private permissions and backups. Until durable private upload storage is configured, do not accept production applications/documents.
- Run behind an HTTPS reverse proxy. Set `COOKIE_SECURE=true`; set `TRUST_PROXY=1` only when there is exactly one trusted proxy in front of Node. Configure PostgreSQL TLS with `PGSSL=true` when required by the database host.
- Set a private, persistent `UPLOAD_DIR` for applicant files. The default `.data/uploads` is not served as static content. Protect the host disk with encryption and limit server/database access; application files contain personal information.
- Back up PostgreSQL with `pg_dump` and include the private uploads directory in an encrypted backup. Test restore procedures before production use.
- SQLite is not used. All application data requires a PostgreSQL connection. Form submissions do not send email or reserve a vehicle automatically.
- The default rate limiter is process-local. For a multi-instance deployment, configure a shared rate-limit store and shared private object storage for uploads.
- Public booking, inquiry, and application forms link to a privacy notice and require affirmative consent. Consent timestamps are recorded for new submissions; earlier records remain nullable rather than being treated as consented.
- Rejected or hired applications and their private documents are eligible for deletion 180 days after the last status update. Preview the eligible count with `npm run applications:prune`; execute deletion with `npm run applications:prune -- --execute`. Schedule the execute command monthly in the hosting environment, monitor its exit status, and make sure backups expire on a documented schedule. The duration is a default policy, not legal advice; an owner must approve it and confirm how hired applicants should be handled before production.
- `/healthz` is a liveness check; `/readyz` checks PostgreSQL and returns only a generic unavailable status when the database cannot be reached. The legacy `/api/health` endpoint remains as a readiness alias. Responses carry an `X-Request-ID`. Server errors are JSON structured logs containing request IDs, route patterns, status and error codes only—not request bodies, raw URLs, or error messages.
- Versioned static filenames containing an 8-or-more-character hexadecimal fingerprint receive `public, max-age=31536000, immutable`. Other public files revalidate; the admin page and all API responses are `private, no-store`.
- Production operations: require HTTPS and `COOKIE_SECURE=true`; keep `.env` out of source control and inject `DATABASE_URL`, cookie/proxy settings, upload paths, and retention settings through the host's secret manager or protected environment configuration. Never include secrets in logs or CI output. Protect the private upload directory and database volumes with encryption at rest and restrict operator access.
- Back up PostgreSQL and the private uploads directory together using encrypted storage, define backup expiration, and perform a documented restore drill before launch and periodically afterward. Configure external uptime checks for `/healthz` and alert on `/readyz` failures, sustained HTTP 5xx rates, failed backup/retention jobs, and low disk space. Keep alerts and diagnostic logs free of applicant data.
- GitHub Actions starts a disposable PostgreSQL service, applies migrations, and runs the integration and unit tests on pushes and pull requests.
- Hosting, CDN/load balancing, shared rate-limit storage, shared/object upload storage, MFA, and multi-region recovery remain deployment choices. Add a shared rate-limit store and shared upload storage if operating more than one app instance; evaluate the other options only when their operational need is established.

### Deployment checklist

- [ ] Owner/legal reviewer approves the privacy notice, contact/rights channel, 180-day application policy (including hired applicants), and booking/inquiry retention schedule; configure `APPLICATION_RETENTION_DAYS`.
- [ ] Provision PostgreSQL and private persistent uploads; set production secrets, `COOKIE_SECURE=true`, and only the verified `TRUST_PROXY` hop count.
- [ ] Enforce HTTPS and PostgreSQL TLS as required by the database host.
- [ ] Configure encrypted database-and-upload backups, expiry, a successful restore drill, and uptime/error/backup/retention alerts.
- [ ] Apply migrations, create an administrator, and run the test suite against the deployment database before launch.
- [ ] Schedule and monitor the application-pruning command; verify the deployment's instance count and select shared rate-limit/upload storage if scaling beyond one instance.

## Tests

Run `npm test`. The integration tests use `TEST_DATABASE_URL` and require that database to have the schema applied; without it, only the database-independent tests run. GitHub Actions provisions a temporary PostgreSQL database and runs migrations before testing.
