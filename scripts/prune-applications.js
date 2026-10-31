require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { pool } = require("../src/db");

const uploadDirectory = path.resolve(__dirname, "..", process.env.UPLOAD_DIR || ".data/uploads");

function retentionDays() {
    const days = Number(process.env.APPLICATION_RETENTION_DAYS || 180);
    if (!Number.isSafeInteger(days) || days < 1) {
        throw new Error("APPLICATION_RETENTION_DAYS must be a positive whole number.");
    }
    return days;
}

function uploadPaths(files) {
    const paths = [];
    for (const file of Object.values(files || {})) {
        const parts = typeof file?.path === "string" ? file.path.split(/[\\/]+/) : [];
        if (parts.length !== 2
            || !/^[0-9a-f-]{36}$/i.test(parts[0])
            || !/^(photo|ocr-file|drivers-license)\.(pdf|jpg|jpeg|png)$/i.test(parts[1])) {
            throw new Error("Application contains an invalid private document reference.");
        }
        paths.push({ file: path.join(uploadDirectory, ...parts), directory: path.join(uploadDirectory, parts[0]) });
    }
    return paths;
}

async function removeDocuments(files) {
    const entries = uploadPaths(files);
    for (const entry of entries) {
        try {
            await fs.unlink(entry.file);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    for (const directory of new Set(entries.map((entry) => entry.directory))) {
        try {
            await fs.rmdir(directory);
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        }
    }
}

async function pruneApplications(execute, days) {
    const criteria = `status IN ('rejected', 'hired')
        AND updated_at < now() - ($1::int * interval '1 day')`;
    if (!execute) {
        const result = await pool.query(`SELECT count(*)::int AS count FROM applications WHERE ${criteria}`, [days]);
        console.log(JSON.stringify({ event: "applications.retention_dry_run", eligible: result.rows[0].count, retention_days: days }));
        return;
    }

    const candidates = await pool.query(
        `SELECT id FROM applications WHERE ${criteria} ORDER BY updated_at`,
        [days],
    );
    let deleted = 0;
    for (const candidate of candidates.rows) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await client.query(
                `SELECT files FROM applications
                WHERE id = $2 AND ${criteria}
                FOR UPDATE`,
                [days, candidate.id],
            );
            if (!result.rowCount) {
                await client.query("COMMIT");
                continue;
            }
            await removeDocuments(result.rows[0].files);
            await client.query("DELETE FROM applications WHERE id = $1", [candidate.id]);
            await client.query("COMMIT");
            deleted += 1;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
    console.log(JSON.stringify({ event: "applications.retention_complete", deleted, retention_days: days }));
}

async function main() {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--execute") || args.length > 1) {
        throw new Error("Usage: node scripts/prune-applications.js [--execute]");
    }
    await pruneApplications(args.includes("--execute"), retentionDays());
}

main()
    .catch((error) => {
        console.error(JSON.stringify({
            event: "applications.retention_error",
            error_type: error.name || "Error",
            error_code: typeof error.code === "string" ? error.code : undefined,
        }));
        process.exitCode = 1;
    })
    .finally(() => pool.end());
