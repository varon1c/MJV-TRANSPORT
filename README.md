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

- Run behind an HTTPS reverse proxy. Set `COOKIE_SECURE=true`; set `TRUST_PROXY=1` only when there is exactly one trusted proxy in front of Node. Configure PostgreSQL TLS with `PGSSL=true` when required by the database host.
- Set a private, persistent `UPLOAD_DIR` for applicant files. The default `.data/uploads` is not served as static content. Protect the host disk with encryption and limit server/database access; application files contain personal information.
- Back up PostgreSQL with `pg_dump` and include the private uploads directory in an encrypted backup. Test restore procedures before production use.
- SQLite is not used. All application data requires a PostgreSQL connection. Form submissions do not send email or reserve a vehicle automatically.
- The default rate limiter is process-local. For a multi-instance deployment, configure a shared rate-limit store and shared private object storage for uploads.
- Before going live, provide an appropriate privacy notice, set document retention/deletion rules, and configure database backups and HTTPS. No production hosting credentials or external notification service are included.

## Tests

Run `npm test`. The integration tests use `TEST_DATABASE_URL` and require that database to have the schema applied; without it, only the database-independent validation tests run.
