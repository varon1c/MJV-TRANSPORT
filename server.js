require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const multer = require("multer");
const { pool } = require("./src/db");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || ".data/uploads");
const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MAX_UPLOAD_SIZE = 8 * 1024 * 1024;
const BUSINESS_TIME_ZONE = "Asia/Manila";
const FILE_FIELDS = ["photo", "ocr-file", "drivers-license"];

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requiredText(value, label, maximum = 200) {
    if (typeof value !== "string" || !value.trim()) {
        throw new HttpError(400, `${label} is required.`);
    }
    const text = value.trim();
    if (text.length > maximum) {
        throw new HttpError(400, `${label} must be ${maximum} characters or fewer.`);
    }
    return text;
}

function optionalText(value, label, maximum = 500) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw new HttpError(400, `${label} must be text.`);
    const text = value.trim();
    if (text.length > maximum) {
        throw new HttpError(400, `${label} must be ${maximum} characters or fewer.`);
    }
    return text;
}

function emailAddress(value) {
    if (typeof value !== "string") throw new HttpError(400, "Enter a valid email address.");
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpError(400, "Enter a valid email address.");
    }
    return email;
}

function dateValue(value, label, rejectPast = false) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new HttpError(400, `${label} must be a valid date.`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new HttpError(400, `${label} must be a valid date.`);
    }
    const businessDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: BUSINESS_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
    if (rejectPast && value < businessDate) {
        throw new HttpError(400, `${label} cannot be in the past.`);
    }
    return value;
}

function dateTime(date, time, dateLabel, timeLabel) {
    dateValue(date, dateLabel, true);
    if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new HttpError(400, `${timeLabel} must be a valid time.`);
    }
    const parsed = new Date(`${date}T${time}:00+08:00`);
    if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `${timeLabel} must be valid.`);
    if (parsed.getTime() < Date.now()) {
        throw new HttpError(400, `${dateLabel} and time cannot be in the past.`);
    }
    return parsed;
}

function positiveId(value, label) {
    if (!/^[1-9]\d*$/.test(String(value))) throw new HttpError(400, `Select a valid ${label}.`);
    const id = Number(value);
    if (!Number.isSafeInteger(id)) throw new HttpError(400, `Select a valid ${label}.`);
    return id;
}

function passwordHash(password) {
    if (typeof password !== "string" || password.length < 14 || password.length > 256) {
        throw new HttpError(400, "Admin passwords must be between 14 and 256 characters.");
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, encoded) {
    try {
        const [algorithm, saltHex, hashHex] = encoded.split("$");
        if (algorithm !== "scrypt") return false;
        const expected = Buffer.from(hashHex, "hex");
        const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
            N: 16384, r: 8, p: 1,
        });
        return crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function clientIp(req) {
    return req.ip;
}

function requestLimiter(max, windowMs, message) {
    return rateLimit({
        windowMs,
        limit: max,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        handler: (_req, res) => res.status(429).json({ error: message }),
    });
}

function requirePrivacyConsent(value) {
    if (value !== true && value !== "true") {
        throw new HttpError(400, "Consent to the privacy notice is required.");
    }
}

function staticCacheControl(filePath) {
    const filename = path.basename(filePath);
    if (filename === "admin.html") return "private, no-store";
    if (/(?:^|[.-])[a-f0-9]{8,}(?:[.-]|$)/i.test(filename)) {
        return "public, max-age=31536000, immutable";
    }
    return "no-cache";
}

function logRequestError(error, req, status) {
    console.error(JSON.stringify({
        event: "request.error",
        request_id: req.requestId,
        method: req.method,
        route: req.route?.path || "unmatched",
        status,
        error_type: error.name || "Error",
        error_code: typeof error.code === "string" ? error.code : undefined,
    }));
}

function safeFilename(filename) {
    return path.basename(filename).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180) || "document";
}

function fileExtension(filename) {
    return path.extname(filename).toLowerCase();
}

function validateUpload(field, file) {
    const extension = fileExtension(file.originalname);
    const isPdf = file.buffer.subarray(0, 5).toString() === "%PDF-";
    const isJpeg = file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
    const isPng = file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const allowed = field === "photo" ? [".jpg", ".jpeg", ".png"] : [".pdf", ".jpg", ".jpeg", ".png"];
    const validSignature = extension === ".pdf" ? isPdf
        : [".jpg", ".jpeg"].includes(extension) ? isJpeg
            : extension === ".png" && isPng;
    if (!allowed.includes(extension) || !validSignature) {
        const accepted = field === "photo" ? "JPG or PNG image" : "PDF, JPG, or PNG file";
        throw new HttpError(400, `${field.replaceAll("-", " ")} must be a valid ${accepted}.`);
    }
    return extension;
}

function createApplication() {
    const app = express();
    app.disable("x-powered-by");
    const proxyHops = Number.parseInt(process.env.TRUST_PROXY || "0", 10);
    if (Number.isInteger(proxyHops) && proxyHops > 0) app.set("trust proxy", proxyHops);
    let publicOrigin = null;
    if (process.env.PUBLIC_ORIGIN) {
        const configuredUrl = new URL(process.env.PUBLIC_ORIGIN);
        if (!["http:", "https:"].includes(configuredUrl.protocol)
            || configuredUrl.pathname !== "/" || configuredUrl.search || configuredUrl.hash) {
            throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path.");
        }
        publicOrigin = configuredUrl.origin.toLowerCase();
    }

    app.use((req, res, next) => {
        req.requestId = crypto.randomUUID();
        res.setHeader("X-Request-ID", req.requestId);
        next();
    });
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                baseUri: ["'self'"],
                connectSrc: ["'self'"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                imgSrc: ["'self'", "data:"],
                objectSrc: ["'none'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "https://fonts.googleapis.com"],
            },
        },
        crossOriginEmbedderPolicy: false,
    }));
    app.use("/api", (_req, res, next) => {
        res.setHeader("Cache-Control", "private, no-store");
        next();
    });
    app.use(["/healthz", "/readyz"], (_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
    });
    app.use(express.json({ limit: "32kb", strict: true }));

    const checkOrigin = (req, _res, next) => {
        const origin = req.get("origin");
        if (!origin) return next();
        try {
            const requestOrigin = new URL(origin);
            const allowed = publicOrigin
                ? requestOrigin.origin.toLowerCase() === publicOrigin
                : requestOrigin.host.toLowerCase() === req.get("host").toLowerCase();
            if (!allowed) {
                throw new HttpError(403, "Request origin is not allowed.");
            }
        } catch (error) {
            if (error instanceof HttpError) return next(error);
            return next(new HttpError(403, "Request origin is not allowed."));
        }
        return next();
    };

    const publicFormLimiter = requestLimiter(8, 15 * 60 * 1000, "Please wait before submitting another request.");
    const applicationLimiter = requestLimiter(4, 60 * 60 * 1000, "Please wait before submitting another application.");
    const loginLimiter = requestLimiter(8, 15 * 60 * 1000, "Too many sign-in attempts. Try again later.");
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: MAX_FILE_SIZE, files: 3, fields: 16, parts: 24 },
    }).fields(FILE_FIELDS.map((name) => ({ name, maxCount: 1 })));

    app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
    const readinessCheck = asyncRoute(async (req, res) => {
        try {
            await pool.query("SELECT 1");
            res.json({ status: "ok" });
        } catch (error) {
            logRequestError(error, req, 503);
            res.status(503).json({ status: "unavailable" });
        }
    });
    app.get("/readyz", readinessCheck);
    app.get("/api/health", readinessCheck);

    app.get("/api/vehicles", asyncRoute(async (_req, res) => {
        const { rows } = await pool.query(
            `SELECT id, name, model, category, description, capacity, rental_rate, image_path
            FROM vehicles WHERE is_active = TRUE AND availability_status = 'available'
            ORDER BY id`
        );
        res.json({ vehicles: rows });
    }));

    app.get("/api/availability", asyncRoute(async (req, res) => {
        const id = positiveId(req.query.vehicle_id, "vehicle");
        const pickup = dateTime(req.query.pickup_date, req.query.pickup_time, "Pickup date", "Pickup time");
        const returned = dateTime(req.query.return_date, req.query.return_time, "Return date", "Return time");
        if (returned <= pickup) throw new HttpError(400, "Return date and time must be after pickup.");
        const { rows } = await pool.query(
            `SELECT v.id, v.capacity,
                NOT EXISTS (
                    SELECT 1 FROM bookings b
                    WHERE b.vehicle_id = v.id AND b.status = 'confirmed'
                    AND b.pickup_at < $3 AND b.return_at > $2
                ) AS available
            FROM vehicles v
            WHERE v.id = $1 AND v.is_active = TRUE AND v.availability_status = 'available'`,
            [id, pickup, returned],
        );
        res.json(rows[0] || { available: false });
    }));

    app.post("/api/bookings", checkOrigin, publicFormLimiter, asyncRoute(async (req, res) => {
        requirePrivacyConsent(req.body.privacy_consent);
        const firstName = requiredText(req.body.first_name, "First name", 100);
        const lastName = requiredText(req.body.last_name, "Last name", 100);
        const email = emailAddress(req.body.email);
        const phone = optionalText(req.body.phone, "Phone number", 40);
        const vehicleId = positiveId(req.body.vehicle_id, "vehicle");
        const pickup = dateTime(req.body.pickup_date, req.body.pickup_time, "Pickup date", "Pickup time");
        const returned = dateTime(req.body.return_date, req.body.return_time, "Return date", "Return time");
        if (returned <= pickup) throw new HttpError(400, "Return date and time must be after pickup.");
        if (returned.getTime() - pickup.getTime() > 366 * 24 * 60 * 60 * 1000) {
            throw new HttpError(400, "A trip cannot be longer than one year.");
        }
        const pickupLocation = requiredText(req.body.pickup_location, "Pickup location", 250);
        const destination = optionalText(req.body.destination, "Destination", 250);
        const specialRequests = optionalText(req.body.special_requests, "Special requests", 2000);
        const passengers = Number(req.body.passengers);
        if (!Number.isSafeInteger(passengers) || passengers < 1 || passengers > 100) {
            throw new HttpError(400, "Passenger count must be between 1 and 100.");
        }

        const client = await pool.connect();
        let booking;
        try {
            await client.query("BEGIN");
            const vehicle = await client.query(
                `SELECT id, capacity FROM vehicles
                WHERE id = $1 AND is_active = TRUE AND availability_status = 'available'
                FOR UPDATE`,
                [vehicleId],
            );
            if (!vehicle.rowCount) throw new HttpError(409, "That vehicle is not currently available.");
            if (passengers > vehicle.rows[0].capacity) {
                throw new HttpError(400, `This vehicle has capacity for up to ${vehicle.rows[0].capacity} passengers.`);
            }
            const conflict = await client.query(
                `SELECT reference FROM bookings
                WHERE vehicle_id = $1 AND status = 'confirmed'
                AND pickup_at < $3 AND return_at > $2 LIMIT 1`,
                [vehicleId, pickup, returned],
            );
            if (conflict.rowCount) {
                throw new HttpError(409, "That vehicle already has a confirmed booking for those dates.");
            }
            const customer = await client.query(
                `INSERT INTO customers (full_name, email, phone)
                VALUES ($1, $2, $3)
                ON CONFLICT (email) DO UPDATE SET
                    full_name = EXCLUDED.full_name,
                    phone = CASE WHEN EXCLUDED.phone = '' THEN customers.phone ELSE EXCLUDED.phone END,
                    updated_at = now()
                RETURNING id`,
                [`${firstName} ${lastName}`, email, phone],
            );
            const reference = `MJV-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
            const result = await client.query(
                `INSERT INTO bookings
                (reference, customer_id, vehicle_id, pickup_at, return_at, pickup_location,
                 destination, passengers, special_requests, privacy_consent_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
                RETURNING id, reference, status`,
                [
                    reference, customer.rows[0].id, vehicleId, pickup, returned,
                    pickupLocation, destination, passengers, specialRequests,
                ],
            );
            booking = result.rows[0];
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        res.status(201).json(booking);
    }));

    app.post("/api/inquiries", checkOrigin, publicFormLimiter, asyncRoute(async (req, res) => {
        requirePrivacyConsent(req.body.privacy_consent);
        const firstName = requiredText(req.body.first_name, "First name", 100);
        const lastName = requiredText(req.body.last_name, "Last name", 100);
        const email = emailAddress(req.body.email);
        const phone = optionalText(req.body.phone, "Phone number", 40);
        const subject = requiredText(req.body.subject, "Subject", 160);
        const message = requiredText(req.body.message, "Message", 5000);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const customer = await client.query(
                `INSERT INTO customers (full_name, email, phone)
                VALUES ($1, $2, $3)
                ON CONFLICT (email) DO UPDATE SET
                    full_name = EXCLUDED.full_name,
                    phone = CASE WHEN EXCLUDED.phone = '' THEN customers.phone ELSE EXCLUDED.phone END,
                    updated_at = now()
                RETURNING id`,
                [`${firstName} ${lastName}`, email, phone],
            );
            const result = await client.query(
                `INSERT INTO inquiries (customer_id, subject, message, privacy_consent_at)
                VALUES ($1, $2, $3, now()) RETURNING id, status`,
                [customer.rows[0].id, subject, message],
            );
            await client.query("COMMIT");
            res.status(201).json({ inquiry_id: result.rows[0].id, status: result.rows[0].status });
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }));

    app.post("/api/applications", checkOrigin, applicationLimiter, (req, res, next) => {
        upload(req, res, (error) => {
            if (error) return next(error);
            return next();
        });
    }, asyncRoute(async (req, res) => {
        requirePrivacyConsent(req.body.privacy_consent);
        const first = requiredText(req.body.first_name, "First name", 100);
        const middle = optionalText(req.body.middle_initial, "Middle initial", 1);
        const last = requiredText(req.body.last_name, "Last name", 100);
        const email = emailAddress(req.body.email);
        const phone = optionalText(req.body.phone, "Phone number", 40);
        const position = requiredText(req.body.position, "Position", 120);
        const birthday = dateValue(req.body.birthday, "Birthday");
        if (birthday >= new Intl.DateTimeFormat("en-CA", {
            timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date())) {
            throw new HttpError(400, "Birthday must be in the past.");
        }
        const gender = requiredText(req.body.gender, "Gender", 20);
        if (!["male", "female", "other"].includes(gender)) throw new HttpError(400, "Select a valid gender.");
        const nationality = requiredText(req.body.nationality, "Nationality", 100);
        const birthplace = requiredText(req.body.birthplace, "Birthplace", 150);
        const message = optionalText(req.body.message, "Message", 3000);
        const files = req.files || {};
        const missing = FILE_FIELDS.filter((field) => !files[field]?.[0]);
        if (missing.length) {
            throw new HttpError(400, "Upload a photo, an identity document, and a driver's license.");
        }
        const uploads = FILE_FIELDS.map((field) => ({
            field,
            file: files[field][0],
            extension: validateUpload(field, files[field][0]),
        }));
        const totalBytes = uploads.reduce((total, item) => total + item.file.size, 0);
        if (totalBytes > MAX_UPLOAD_SIZE) throw new HttpError(413, "Combined document size must be 8 MB or smaller.");

        const directory = path.join(UPLOAD_DIR, crypto.randomUUID());
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const savedFiles = {};
        try {
            for (const { field, file, extension } of uploads) {
                const filename = `${field}${extension}`;
                const destination = path.join(directory, filename);
                await fs.promises.writeFile(destination, file.buffer, { mode: 0o600, flag: "wx" });
                savedFiles[field] = {
                    path: path.relative(UPLOAD_DIR, destination),
                    name: safeFilename(file.originalname),
                };
            }
            const result = await pool.query(
                `INSERT INTO applications
                (full_name, email, phone, position, birthday, gender, nationality, birthplace,
                 message, files, privacy_consent_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
                RETURNING id, status`,
                [
                    [first, middle, last].filter(Boolean).join(" "),
                    email, phone, position, birthday, gender, nationality, birthplace,
                    message, JSON.stringify(savedFiles),
                ],
            );
            res.status(201).json({
                application_id: result.rows[0].id,
                status: result.rows[0].status,
            });
        } catch (error) {
            await fs.promises.rm(directory, { recursive: true, force: true });
            throw error;
        }
    }));

    const adminSession = asyncRoute(async (req, res, next) => {
        const token = (req.get("cookie") || "")
            .split(";")
            .map((item) => item.trim())
            .find((item) => item.startsWith("mjv_admin="))
            ?.slice("mjv_admin=".length);
        if (!token || !/^[a-f0-9]{64}$/.test(token)) {
            throw new HttpError(401, "Admin sign-in is required.");
        }
        const sessionHash = crypto.createHash("sha256").update(token).digest("hex");
        const { rows } = await pool.query(
            `SELECT s.session_hash, s.csrf_token, a.id, a.username
            FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_user_id
            WHERE s.session_hash = $1 AND s.expires_at > now()`,
            [sessionHash],
        );
        if (!rows.length) throw new HttpError(401, "Admin session expired. Sign in again.");
        req.admin = rows[0];
        req.admin.sessionHash = sessionHash;
        return next();
    });

    const csrfProtection = (req, _res, next) => {
        const submitted = req.get("x-csrf-token") || "";
        if (!/^[a-f0-9]{64}$/.test(submitted)
            || submitted.length !== req.admin.csrf_token.length
            || !crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(req.admin.csrf_token))) {
            return next(new HttpError(403, "Security token expired; refresh and try again."));
        }
        return next();
    };

    const requireAdmin = [adminSession, (req, _res, next) => {
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) return csrfProtection(req, _res, next);
        return next();
    }];

    app.post("/api/admin/login", checkOrigin, loginLimiter, asyncRoute(async (req, res) => {
        const username = requiredText(req.body.username, "Username", 64);
        const password = req.body.password;
        if (typeof password !== "string" || password.length < 1 || password.length > 256) {
            throw new HttpError(400, "Enter a valid password.");
        }
        const { rows } = await pool.query(
            "SELECT id, username, password_hash FROM admin_users WHERE username = $1",
            [username],
        );
        if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
            throw new HttpError(401, "Username or password is incorrect.");
        }
        const token = crypto.randomBytes(32).toString("hex");
        const csrf = crypto.randomBytes(32).toString("hex");
        const sessionHash = crypto.createHash("sha256").update(token).digest("hex");
        await pool.query("DELETE FROM admin_sessions WHERE expires_at <= now()");
        await pool.query(
            `INSERT INTO admin_sessions (session_hash, admin_user_id, csrf_token, expires_at)
            VALUES ($1, $2, $3, now() + interval '4 hours')`,
            [sessionHash, rows[0].id, csrf],
        );
        const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
        res.setHeader(
            "Set-Cookie",
            `mjv_admin=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=14400${secure}`,
        );
        res.json({ username: rows[0].username, csrf });
    }));

    app.get("/api/admin/session", requireAdmin, (req, res) => {
        res.json({ username: req.admin.username, csrf: req.admin.csrf_token });
    });

    app.post("/api/admin/logout", checkOrigin, requireAdmin, asyncRoute(async (req, res) => {
        await pool.query("DELETE FROM admin_sessions WHERE session_hash = $1", [req.admin.sessionHash]);
        const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
        res.setHeader(
            "Set-Cookie",
            `mjv_admin=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
        );
        res.json({ ok: true });
    }));

    app.get("/api/admin/dashboard", requireAdmin, asyncRoute(async (req, res) => {
        const search = String(req.query.search || "").trim().slice(0, 120);
        const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
        const [countsResult, vehicles, bookings, inquiries, applications, audit] = await Promise.all([
            pool.query(
                `SELECT
                    (SELECT count(*)::int FROM bookings WHERE status = 'pending') AS pending_bookings,
                    (SELECT count(*)::int FROM bookings WHERE status = 'confirmed') AS confirmed_bookings,
                    (SELECT count(*)::int FROM vehicles WHERE is_active) AS active_vehicles,
                    (SELECT count(*)::int FROM inquiries WHERE status IN ('new', 'in_progress')) AS open_inquiries,
                    (SELECT count(*)::int FROM applications WHERE status IN ('new', 'reviewing', 'shortlisted')) AS open_applications`
            ),
            pool.query("SELECT * FROM vehicles ORDER BY is_active DESC, name"),
            pool.query(
                `SELECT b.id, b.reference, b.pickup_at, b.return_at, b.pickup_location,
                    b.destination, b.passengers, b.special_requests, b.quoted_amount, b.status,
                    b.admin_notes, b.created_at, v.name AS vehicle_name, v.model AS vehicle_model,
                    c.full_name, c.email, c.phone
                FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
                JOIN customers c ON c.id = b.customer_id
                WHERE b.reference ILIKE $1 OR c.full_name ILIKE $1 OR c.email ILIKE $1
                ORDER BY b.created_at DESC LIMIT 200`,
                [pattern],
            ),
            pool.query(
                `SELECT i.id, i.subject, i.message, i.status, i.admin_notes, i.created_at,
                    c.full_name, c.email, c.phone
                FROM inquiries i JOIN customers c ON c.id = i.customer_id
                WHERE i.subject ILIKE $1 OR i.message ILIKE $1 OR c.full_name ILIKE $1 OR c.email ILIKE $1
                ORDER BY i.created_at DESC LIMIT 200`,
                [pattern],
            ),
            pool.query(
                `SELECT id, full_name, email, phone, position, birthday, gender, nationality,
                    birthplace, message, files, status, admin_notes, created_at
                FROM applications
                WHERE full_name ILIKE $1 OR email ILIKE $1 OR position ILIKE $1
                ORDER BY created_at DESC LIMIT 200`,
                [pattern],
            ),
            pool.query(
                `SELECT admin_username, action, entity_type, entity_id, created_at
                FROM audit_log ORDER BY id DESC LIMIT 50`,
            ),
        ]);
        res.json({
            counts: countsResult.rows[0],
            vehicles: vehicles.rows,
            bookings: bookings.rows,
            inquiries: inquiries.rows,
            applications: applications.rows,
            audit: audit.rows,
        });
    }));

    app.post("/api/admin/vehicles", requireAdmin, asyncRoute(async (req, res) => {
        const vehicle = vehicleInput(req.body);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(
                `INSERT INTO vehicles
                (name, model, category, description, capacity, rental_rate, image_path,
                 availability_status, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id`,
                vehicle,
            );
            await audit(req.admin.username, "create", "vehicle", result.rows[0].id, { name: vehicle[0] }, client);
            await client.query("COMMIT");
            res.status(201).json({ vehicle_id: result.rows[0].id });
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }));

    app.put("/api/admin/vehicles/:id", requireAdmin, asyncRoute(async (req, res) => {
        const id = positiveId(req.params.id, "vehicle");
        const vehicle = vehicleInput(req.body);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(
                `UPDATE vehicles SET name = $1, model = $2, category = $3, description = $4,
                    capacity = $5, rental_rate = $6, image_path = $7, availability_status = $8,
                    is_active = $9, updated_at = now()
                WHERE id = $10 RETURNING id`,
                [...vehicle, id],
            );
            if (!result.rowCount) throw new HttpError(404, "Vehicle not found.");
            await audit(req.admin.username, "update", "vehicle", id, { name: vehicle[0] }, client);
            await client.query("COMMIT");
            res.json({ vehicle_id: id });
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }));

    app.patch("/api/admin/bookings/:id", requireAdmin, asyncRoute(async (req, res) => {
        const id = positiveId(req.params.id, "booking");
        const { status, notes } = statusAndNotes(req.body, [
            "pending", "confirmed", "rejected", "cancelled", "completed",
        ]);
        let quotedAmount = null;
        if (req.body.quoted_amount !== "" && req.body.quoted_amount !== null
            && req.body.quoted_amount !== undefined) {
            quotedAmount = Number(req.body.quoted_amount);
            if (!Number.isFinite(quotedAmount) || quotedAmount < 0 || quotedAmount > 10_000_000) {
                throw new HttpError(400, "Quoted amount must be a non-negative number.");
            }
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const booking = await client.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [id]);
            if (!booking.rowCount) throw new HttpError(404, "Booking not found.");
            if (status === "confirmed") {
                await client.query("SELECT id FROM vehicles WHERE id = $1 FOR UPDATE", [booking.rows[0].vehicle_id]);
                const conflict = await client.query(
                    `SELECT reference FROM bookings WHERE vehicle_id = $1 AND id <> $2
                    AND status = 'confirmed' AND pickup_at < $4 AND return_at > $3 LIMIT 1`,
                    [booking.rows[0].vehicle_id, id, booking.rows[0].pickup_at, booking.rows[0].return_at],
                );
                if (conflict.rowCount) {
                    throw new HttpError(409, `These dates overlap confirmed booking ${conflict.rows[0].reference}.`);
                }
            }
            await client.query(
                "UPDATE bookings SET status = $1, admin_notes = $2, quoted_amount = $3, updated_at = now() WHERE id = $4",
                [status, notes, quotedAmount, id],
            );
            await audit(req.admin.username, "status_update", "booking", id, { status }, client);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        res.json({ ok: true });
    }));

    app.patch("/api/admin/inquiries/:id", requireAdmin, asyncRoute(async (req, res) => {
        await updateStatus("inquiries", "inquiry", req, [
            "new", "in_progress", "resolved", "archived",
        ]);
        res.json({ ok: true });
    }));

    app.patch("/api/admin/applications/:id", requireAdmin, asyncRoute(async (req, res) => {
        await updateStatus("applications", "application", req, [
            "new", "reviewing", "shortlisted", "rejected", "hired",
        ]);
        res.json({ ok: true });
    }));

    app.get("/api/admin/applications/:id/files/:field", requireAdmin, asyncRoute(async (req, res) => {
        const id = positiveId(req.params.id, "application");
        if (!FILE_FIELDS.includes(req.params.field)) throw new HttpError(404, "Document not found.");
        const { rows } = await pool.query("SELECT files FROM applications WHERE id = $1", [id]);
        const file = rows[0]?.files?.[req.params.field];
        if (!file) throw new HttpError(404, "Document not found.");
        const absolute = path.resolve(UPLOAD_DIR, file.path);
        if (!absolute.startsWith(`${UPLOAD_DIR}${path.sep}`)) throw new HttpError(404, "Document not found.");
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.download(absolute, safeFilename(file.name), (error) => {
            if (error && !res.headersSent) res.status(404).json({ error: "Document not found." });
        });
    }));

    app.get("/admin", (_req, res) => {
        res.setHeader("Cache-Control", "private, no-store");
        res.redirect(302, "/admin.html");
    });
    app.use(["/server.js", "/package.json", "/package-lock.json", "/db", "/scripts", "/src", "/tests", "/node_modules"],
        (_req, res) => res.sendStatus(404));
    app.use(express.static(PUBLIC_DIR, {
        dotfiles: "deny",
        index: "index.html",
        redirect: false,
        setHeaders: (res, filePath) => {
            res.setHeader("Cache-Control", staticCacheControl(filePath));
        },
    }));
    app.use((_req, res) => res.status(404).send("Not found."));

    app.use((error, req, res, _next) => {
        if (error instanceof multer.MulterError) {
            const tooLarge = error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT";
            return res.status(tooLarge ? 413 : 400).json({
                error: tooLarge ? "Documents must be 3 MB each or fewer." : "The uploaded documents could not be processed.",
            });
        }
        if (error.type === "entity.too.large") {
            return res.status(413).json({ error: "Request is too large." });
        }
        if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
            return res.status(400).json({ error: "Request body must be valid JSON." });
        }
        if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
        if (error.code === "23505") return res.status(409).json({ error: "A record with those details already exists." });
        if (error.code === "23P01") {
            return res.status(409).json({ error: "The vehicle already has a confirmed booking for those dates." });
        }
        if (error.code === "23503" || error.code === "23514") {
            return res.status(400).json({ error: "The submitted data does not meet the database requirements." });
        }
        logRequestError(error, req, 500);
        return res.status(500).json({ error: "The request could not be completed." });
    });
    return app;
}

function vehicleInput(data) {
    const name = requiredText(data.name, "Vehicle name", 120);
    const model = requiredText(data.model, "Vehicle model", 120);
    const category = requiredText(data.category, "Vehicle category", 60);
    const description = optionalText(data.description, "Description", 1000);
    const capacity = Number(data.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) {
        throw new HttpError(400, "Passenger capacity must be between 1 and 100.");
    }
    let rate = null;
    if (data.rental_rate !== "" && data.rental_rate !== null && data.rental_rate !== undefined) {
        rate = Number(data.rental_rate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 10_000_000) {
            throw new HttpError(400, "Rental rate must be a non-negative number.");
        }
    }
    const imagePath = optionalText(data.image_path, "Image path", 250) || "images/van.png";
    if (!/^images\/[A-Za-z0-9_.\-/]+$/.test(imagePath)
        || imagePath.split("/").includes("..")
        || !fs.existsSync(path.resolve(PUBLIC_DIR, imagePath))) {
        throw new HttpError(400, "Choose an existing image inside the images folder.");
    }
    const availability = data.availability_status || "available";
    if (!["available", "unavailable"].includes(availability)) {
        throw new HttpError(400, "Choose a valid availability status.");
    }
    if (typeof data.is_active !== "boolean") throw new HttpError(400, "Active must be a boolean value.");
    return [
        name, model, category, description, capacity, rate, imagePath, availability, data.is_active,
    ];
}

function statusAndNotes(data, allowedStatuses) {
    if (!allowedStatuses.includes(data.status)) throw new HttpError(400, "Select a valid status.");
    return { status: data.status, notes: optionalText(data.admin_notes, "Administrative notes", 3000) };
}

async function audit(username, action, entityType, entityId, details = {}, executor = pool) {
    await executor.query(
        `INSERT INTO audit_log (admin_username, action, entity_type, entity_id, details)
        VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [username, action, entityType, String(entityId), JSON.stringify(details)],
    );
}

async function updateStatus(table, entityType, req, statuses) {
    const id = positiveId(req.params.id, entityType);
    const { status, notes } = statusAndNotes(req.body, statuses);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `UPDATE ${table} SET status = $1, admin_notes = $2, updated_at = now()
            WHERE id = $3 RETURNING id`,
            [status, notes, id],
        );
        if (!result.rowCount) throw new HttpError(404, `${entityType} not found.`);
        await audit(req.admin.username, "status_update", entityType, id, { status }, client);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function startServer() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.");
    }
    await pool.query("SELECT 1 FROM vehicles LIMIT 1");
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    const host = process.env.HOST || "127.0.0.1";
    const port = Number(process.env.PORT || 8000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
    const app = createApplication();
    return app.listen(port, host, () => {
        console.log(JSON.stringify({ event: "server.listening", host, port }));
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error(JSON.stringify({
            event: "server.startup_error",
            error_type: error.name || "Error",
            error_code: typeof error.code === "string" ? error.code : undefined,
        }));
        process.exitCode = 1;
    });
}

module.exports = {
    createApplication,
    dateTime,
    emailAddress,
    passwordHash,
    positiveId,
    requiredText,
    staticCacheControl,
    startServer,
    verifyPassword,
};
