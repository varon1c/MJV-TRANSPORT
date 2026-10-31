require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined,
    max: Number.parseInt(process.env.PG_POOL_SIZE || "10", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

pool.on("error", (error) => {
    console.error(JSON.stringify({
        event: "database.pool_error",
        error_code: typeof error.code === "string" ? error.code : undefined,
    }));
});

module.exports = { pool };
