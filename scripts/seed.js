require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { pool } = require("../src/db");

async function seed() {
    const sql = await fs.readFile(path.join(__dirname, "..", "db", "seed.sql"), "utf8");
    await pool.query(sql);
    console.log("Seeded the existing MJV van listings.");
}

seed()
    .catch((error) => {
        console.error("Seed failed:", error.code || error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
