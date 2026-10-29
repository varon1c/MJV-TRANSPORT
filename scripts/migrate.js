require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { pool } = require("../src/db");

async function migrate() {
    const directory = path.join(__dirname, "..", "db", "migrations");
    const files = (await fs.readdir(directory))
        .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
        .sort();
    const client = await pool.connect();
    try {
        await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
        for (const name of files) {
            const existing = await client.query(
                "SELECT 1 FROM schema_migrations WHERE name = $1",
                [name],
            );
            if (existing.rowCount) continue;
            const sql = await fs.readFile(path.join(directory, name), "utf8");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
                await client.query("COMMIT");
                console.log(`Applied migration ${name}`);
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        }
        if (files.length === 0) console.log("No database migrations found.");
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch((error) => {
    console.error("Migration failed:", error.code || error.message);
    process.exitCode = 1;
});
