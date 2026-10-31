const assert = require("node:assert/strict");
const { test } = require("node:test");

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:1/unused";
const {
    createApplication,
    dateTime,
    emailAddress,
    passwordHash,
    positiveId,
    requiredText,
    staticCacheControl,
    verifyPassword,
} = require("../server");

test("serves website pages and assets from the public directory", async (t) => {
    const app = createApplication();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const base = `http://127.0.0.1:${server.address().port}`;
    const pages = [
        "/index.html", "/inquire.html", "/about-us.html", "/contact-us.html",
        "/contact-manong.html", "/apply-here.html", "/make-a-deal.html", "/admin.html", "/privacy.html",
        "/template.html",
    ];
    const localReferences = new Set(["/"]);
    for (const page of pages) {
        const response = await fetch(`${base}${page}`);
        assert.equal(response.status, 200, `${page} should be served`);
        const html = await response.text();
        if (["/apply-here.html", "/contact-us.html", "/make-a-deal.html"].includes(page)) {
            assert.match(html, /<input type="checkbox"[^>]*name="privacy_consent"[^>]*required>/);
            assert.match(html, /href="privacy.html"/);
        }
        for (const [, reference] of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
            if (!reference || reference.startsWith("#")) continue;
            const url = new URL(reference, `${base}${page}`);
            if (url.origin === base) localReferences.add(`${url.pathname}${url.search}`);
        }
    }
    for (const file of [
        ...localReferences, "/css/admin.css", "/js/admin.js",
        "/images/van.png", "/images/telepono.png",
    ]) {
        const response = await fetch(`${base}${file}`);
        assert.equal(response.status, 200, `${file} should be served`);
    }

    const adminRedirect = await fetch(`${base}/admin`, { redirect: "manual" });
    assert.equal(adminRedirect.status, 302);
    assert.equal(adminRedirect.headers.get("location"), "/admin.html");
    assert.equal((await fetch(`${base}/server.js`)).status, 404);
    const adminPage = await fetch(`${base}/admin.html`);
    assert.equal(adminPage.headers.get("cache-control"), "private, no-store");
    const publicPage = await fetch(`${base}/index.html`);
    assert.equal(publicPage.headers.get("cache-control"), "no-cache");
    assert.equal(publicPage.headers.get("x-request-id").length, 36);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    assert.equal(health.headers.get("cache-control"), "no-store");
    const privateApi = await fetch(`${base}/api/admin/dashboard`);
    assert.equal(privateApi.status, 401);
    assert.equal(privateApi.headers.get("cache-control"), "private, no-store");
    const previousError = console.error;
    let readinessLog;
    console.error = (entry) => { readinessLog = entry; };
    let readiness;
    try {
        readiness = await fetch(`${base}/readyz`);
    } finally {
        console.error = previousError;
    }
    const readinessBody = await readiness.json();
    assert.ok([200, 503].includes(readiness.status));
    assert.deepEqual(readinessBody, { status: readiness.status === 200 ? "ok" : "unavailable" });
    assert.match(readiness.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    if (readiness.status === 503) {
        const logEntry = JSON.parse(readinessLog);
        assert.equal(logEntry.event, "request.error");
        assert.equal(logEntry.request_id, readiness.headers.get("x-request-id"));
        assert.equal(Object.hasOwn(logEntry, "message"), false);
    }
});

test("validates and normalizes email addresses", () => {
    assert.equal(emailAddress("  Rider@Example.com "), "rider@example.com");
    assert.throws(() => emailAddress("not-an-email"), /valid email/);
});

test("requires bounded non-empty text", () => {
    assert.equal(requiredText("  MJV  ", "Name"), "MJV");
    assert.throws(() => requiredText("  ", "Name"), /required/);
    assert.throws(() => requiredText("x".repeat(4), "Name", 3), /3 characters/);
});

test("accepts only positive integer identifiers", () => {
    assert.equal(positiveId("12", "vehicle"), 12);
    assert.throws(() => positiveId("0", "vehicle"), /valid vehicle/);
    assert.throws(() => positiveId("1 OR 1=1", "vehicle"), /valid vehicle/);
});

test("parses future Manila pickup date and time", () => {
    const pickup = dateTime("2030-01-02", "08:30", "Pickup date", "Pickup time");
    assert.equal(pickup.toISOString(), "2030-01-02T00:30:00.000Z");
    assert.throws(() => dateTime("2030-02-31", "08:30", "Pickup date", "Pickup time"));
    assert.throws(() => dateTime("2030-01-02", "25:90", "Pickup date", "Pickup time"));
});

test("stores admin passwords as salted hashes and verifies them", () => {
    const encoded = passwordHash("A long test-only passphrase!");
    assert.match(encoded, /^scrypt\$/);
    assert.equal(verifyPassword("A long test-only passphrase!", encoded), true);
    assert.equal(verifyPassword("another passphrase", encoded), false);
});

test("caches only versioned public assets for a year", () => {
    assert.equal(staticCacheControl("main.012345abcdef.js"), "public, max-age=31536000, immutable");
    assert.equal(staticCacheControl("index.css"), "no-cache");
    assert.equal(staticCacheControl("admin.html"), "private, no-store");
});

test("checks browser origins against the configured public site behind a proxy", async (t) => {
    const previousOrigin = process.env.PUBLIC_ORIGIN;
    process.env.PUBLIC_ORIGIN = "https://mjv.example.test";
    let app;
    try {
        app = createApplication();
    } finally {
        if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
        else process.env.PUBLIC_ORIGIN = previousOrigin;
    }

    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (origin) => fetch(`${base}/api/inquiries`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
    });
    assert.equal((await request("https://mjv.example.test")).status, 400);
    assert.equal((await request("https://attacker.example")).status, 403);
});
