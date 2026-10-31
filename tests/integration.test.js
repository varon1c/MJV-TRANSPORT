const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.UPLOAD_DIR = path.join(os.tmpdir(), `mjv-upload-test-${process.pid}`);
}
process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:1/unused";

const { createApplication, passwordHash } = require("../server");
const { pool } = require("../src/db");

test("PostgreSQL form, booking, upload, and admin workflows", { skip: !testDatabaseUrl }, async (t) => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const username = `admin_${suffix.slice(0, 12)}`;
    const email = `${suffix}@example.test`;
    const password = "Integration-test-passphrase-2026!";
    const vehicle = await pool.query(
        `INSERT INTO vehicles (name, model, category, capacity, image_path)
        VALUES ($1, 'Test van', 'van', 8, 'images/van.png') RETURNING id`,
        [`Test fleet ${suffix}`],
    );
    const vehicleId = vehicle.rows[0].id;
    await pool.query(
        "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)",
        [username, passwordHash(password)],
    );
    const app = createApplication();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = {
        bookingIds: [], inquiryId: null, applicationId: null, customerId: null,
        adminVehicleId: null,
    };
    const uploadDirectory = process.env.UPLOAD_DIR;

    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        if (created.applicationId) {
            const result = await pool.query(
                "SELECT files FROM applications WHERE id = $1", [created.applicationId],
            );
            await pool.query("DELETE FROM applications WHERE id = $1", [created.applicationId]);
            const folder = result.rows[0]?.files?.photo?.path;
            if (folder) {
                await fs.rm(path.join(uploadDirectory, path.dirname(folder)), {
                    recursive: true,
                    force: true,
                });
            }
        }
        if (created.inquiryId) await pool.query("DELETE FROM inquiries WHERE id = $1", [created.inquiryId]);
        for (const id of created.bookingIds) await pool.query("DELETE FROM bookings WHERE id = $1", [id]);
        if (created.customerId) await pool.query("DELETE FROM customers WHERE id = $1", [created.customerId]);
        await pool.query("DELETE FROM audit_log WHERE admin_username = $1", [username]);
        await pool.query("DELETE FROM admin_users WHERE username = $1", [username]);
        if (created.adminVehicleId) {
            await pool.query("DELETE FROM vehicles WHERE id = $1", [created.adminVehicleId]);
        }
        await pool.query("DELETE FROM vehicles WHERE id = $1", [vehicleId]);
        await fs.rm(uploadDirectory, { recursive: true, force: true });
        await pool.end();
    });

    const origin = { Origin: base };
    const vehicleResponse = await fetch(`${base}/api/vehicles`);
    assert.equal(vehicleResponse.status, 200);
    assert.ok((await vehicleResponse.json()).vehicles.some((item) => String(item.id) === String(vehicleId)));
    assert.equal((await fetch(`${base}/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/api/admin/dashboard`)).status, 401);

    const inquiryResponse = await fetch(`${base}/api/inquiries`, {
        method: "POST",
        headers: { ...origin, "Content-Type": "application/json" },
        body: JSON.stringify({
            first_name: "Integration", last_name: "Test", email, phone: "",
            subject: "Database test", message: "A test inquiry.",
        }),
    });
    assert.equal(inquiryResponse.status, 400);
    assert.match((await inquiryResponse.json()).error, /consent/i);
    const acceptedInquiryResponse = await fetch(`${base}/api/inquiries`, {
        method: "POST",
        headers: { ...origin, "Content-Type": "application/json" },
        body: JSON.stringify({
            first_name: "Integration", last_name: "Test", email, phone: "",
            subject: "Database test", message: "A test inquiry.", privacy_consent: true,
        }),
    });
    assert.equal(acceptedInquiryResponse.status, 201);
    const inquiry = await acceptedInquiryResponse.json();
    created.inquiryId = inquiry.inquiry_id;
    assert.equal(inquiry.status, "new");
    const inquiryConsent = await pool.query(
        "SELECT privacy_consent_at IS NOT NULL AS recorded FROM inquiries WHERE id = $1",
        [created.inquiryId],
    );
    assert.equal(inquiryConsent.rows[0].recorded, true);

    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const pickupDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(future);
    const returnDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(future.getTime() + 24 * 60 * 60 * 1000));
    const bookingBody = {
        first_name: "Integration", last_name: "Test", email,
        vehicle_id: String(vehicleId), pickup_date: pickupDate, pickup_time: "09:00",
        return_date: returnDate, return_time: "18:00", pickup_location: "Porac",
        destination: "Clark", passengers: "3", special_requests: "", privacy_consent: true,
    };
    const submitBooking = (consent = true) => fetch(`${base}/api/bookings`, {
        method: "POST",
        headers: { ...origin, "Content-Type": "application/json" },
        body: JSON.stringify(consent ? bookingBody : Object.fromEntries(
            Object.entries(bookingBody).filter(([key]) => key !== "privacy_consent"),
        )),
    });
    assert.equal((await submitBooking(false)).status, 400);
    const firstBookingResponse = await submitBooking();
    assert.equal(firstBookingResponse.status, 201);
    const firstBooking = await firstBookingResponse.json();
    created.bookingIds.push(firstBooking.id);
    assert.match(firstBooking.reference, /^MJV-[A-F0-9]{10}$/);
    assert.equal(firstBooking.status, "pending");
    const bookingConsent = await pool.query(
        "SELECT privacy_consent_at IS NOT NULL AS recorded FROM bookings WHERE id = $1",
        [firstBooking.id],
    );
    assert.equal(bookingConsent.rows[0].recorded, true);
    const customer = await pool.query("SELECT id FROM customers WHERE email = $1", [email]);
    created.customerId = customer.rows[0].id;

    const secondBookingResponse = await submitBooking();
    assert.equal(secondBookingResponse.status, 201);
    const secondBooking = await secondBookingResponse.json();
    created.bookingIds.push(secondBooking.id);

    const loginResponse = await fetch(`${base}/api/admin/login`, {
        method: "POST",
        headers: { ...origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    const cookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];
    const auth = { Cookie: cookie };
    assert.equal((await fetch(`${base}/api/admin/dashboard`, { headers: auth })).status, 200);

    const vehiclePayload = {
        name: `Admin vehicle ${suffix}`,
        model: "Test model",
        category: "van",
        description: "Test inventory record.",
        capacity: 9,
        rental_rate: 125,
        image_path: "images/van.png",
        availability_status: "available",
        is_active: true,
    };
    const createVehicle = await fetch(`${base}/api/admin/vehicles`, {
        method: "POST",
        headers: {
            ...auth, ...origin, "Content-Type": "application/json", "X-CSRF-Token": login.csrf,
        },
        body: JSON.stringify(vehiclePayload),
    });
    const createVehicleBody = await createVehicle.text();
    assert.equal(createVehicle.status, 201, createVehicleBody);
    created.adminVehicleId = JSON.parse(createVehicleBody).vehicle_id;
    const deactivateVehicle = await fetch(`${base}/api/admin/vehicles/${created.adminVehicleId}`, {
        method: "PUT",
        headers: {
            ...auth, ...origin, "Content-Type": "application/json", "X-CSRF-Token": login.csrf,
        },
        body: JSON.stringify({ ...vehiclePayload, is_active: false }),
    });
    assert.equal(deactivateVehicle.status, 200);
    const publicVehicles = await (await fetch(`${base}/api/vehicles`)).json();
    assert.equal(publicVehicles.vehicles.some((item) => String(item.id) === String(created.adminVehicleId)), false);

    const csrfDenied = await fetch(`${base}/api/admin/bookings/${firstBooking.id}`, {
        method: "PATCH",
        headers: { ...auth, ...origin, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed", admin_notes: "" }),
    });
    assert.equal(csrfDenied.status, 403);
    const confirmFirst = await fetch(`${base}/api/admin/bookings/${firstBooking.id}`, {
        method: "PATCH",
        headers: {
            ...auth, ...origin, "Content-Type": "application/json", "X-CSRF-Token": login.csrf,
        },
        body: JSON.stringify({
            status: "confirmed",
            admin_notes: "Confirmed in test.",
            quoted_amount: 1250,
        }),
    });
    assert.equal(confirmFirst.status, 200);
    const directOverlap = await pool.query(
        "UPDATE bookings SET status = 'confirmed' WHERE id = $1",
        [secondBooking.id],
    ).then(() => null, (error) => error);
    assert.equal(directOverlap.code, "23P01");

    const conflictingConfirmation = await fetch(`${base}/api/admin/bookings/${secondBooking.id}`, {
        method: "PATCH",
        headers: {
            ...auth, ...origin, "Content-Type": "application/json", "X-CSRF-Token": login.csrf,
        },
        body: JSON.stringify({ status: "confirmed", admin_notes: "" }),
    });
    assert.equal(conflictingConfirmation.status, 409);
    const quoted = await pool.query(
        "SELECT quoted_amount FROM bookings WHERE id = $1", [firstBooking.id],
    );
    assert.equal(Number(quoted.rows[0].quoted_amount), 1250);

    const availability = new URLSearchParams({
        vehicle_id: String(vehicleId),
        pickup_date: pickupDate, pickup_time: "09:00",
        return_date: returnDate, return_time: "18:00",
    });
    const availabilityResponse = await fetch(`${base}/api/availability?${availability}`);
    assert.equal((await availabilityResponse.json()).available, false);
    const conflictingRequest = await submitBooking();
    assert.equal(conflictingRequest.status, 409);

    const makeApplicationForm = (consent = true) => {
        const form = new FormData();
        for (const [key, value] of Object.entries({
            first_name: "Applicant", middle_initial: "T", last_name: "Example", email,
            phone: "", position: "Driver", birthday: "1990-01-02", gender: "other",
            nationality: "Filipino", birthplace: "Pampanga", message: "",
        })) form.set(key, value);
        if (consent) form.set("privacy_consent", "true");
        form.set("photo", new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], {
            type: "image/png",
        }), "portrait.png");
        form.set("ocr-file", new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), "identity.pdf");
        form.set("drivers-license", new Blob(["%PDF-1.4\n"], {
            type: "application/pdf",
        }), "license.pdf");
        return form;
    };
    const missingConsent = await fetch(`${base}/api/applications`, {
        method: "POST", headers: origin, body: makeApplicationForm(false),
    });
    assert.equal(missingConsent.status, 400);
    const applicationResponse = await fetch(`${base}/api/applications`, {
        method: "POST", headers: origin, body: makeApplicationForm(),
    });
    assert.equal(applicationResponse.status, 201);
    const application = await applicationResponse.json();
    created.applicationId = application.application_id;
    const applicationConsent = await pool.query(
        "SELECT privacy_consent_at IS NOT NULL AS recorded FROM applications WHERE id = $1",
        [created.applicationId],
    );
    assert.equal(applicationConsent.rows[0].recorded, true);

    const inquiryUpdate = await fetch(`${base}/api/admin/inquiries/${created.inquiryId}`, {
        method: "PATCH",
        headers: {
            ...auth, ...origin, "Content-Type": "application/json", "X-CSRF-Token": login.csrf,
        },
        body: JSON.stringify({ status: "resolved", admin_notes: "Reviewed." }),
    });
    assert.equal(inquiryUpdate.status, 200);
    const applicationUpdate = await fetch(`${base}/api/admin/applications/${created.applicationId}`, {
        method: "PATCH",
        headers: {
            ...auth, ...origin, "Content-Type": "application/json", "X-CSRF-Token": login.csrf,
        },
        body: JSON.stringify({ status: "reviewing", admin_notes: "" }),
    });
    assert.equal(applicationUpdate.status, 200);

    const privateFilePath = `/api/admin/applications/${application.application_id}/files/photo`;
    assert.equal((await fetch(`${base}${privateFilePath}`)).status, 401);
    const privateFile = await fetch(`${base}${privateFilePath}`, { headers: auth });
    assert.equal(privateFile.status, 200);
    assert.equal(privateFile.headers.get("content-disposition").startsWith("attachment;"), true);

    const invalid = await fetch(`${base}/api/inquiries`, {
        method: "POST",
        headers: { ...origin, "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: "Bad", email: "not-an-email" }),
    });
    assert.equal(invalid.status, 400);

    const logout = await fetch(`${base}/api/admin/logout`, {
        method: "POST",
        headers: {
            ...auth, ...origin, "X-CSRF-Token": login.csrf,
        },
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/api/admin/dashboard`, { headers: auth })).status, 401);
});
