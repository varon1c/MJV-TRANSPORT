require("dotenv").config();

const crypto = require("node:crypto");
const { pool } = require("../src/db");

function readHidden(prompt) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
            reject(new Error("Run this admin command from an interactive terminal."));
            return;
        }
        process.stdout.write(prompt);
        let value = "";
        const onData = (chunk) => {
            for (const char of chunk.toString("utf8")) {
                if (char === "\u0003") {
                    cleanup();
                    process.stdout.write("\n");
                    reject(new Error("Cancelled."));
                    return;
                }
                if (char === "\r" || char === "\n") {
                    cleanup();
                    process.stdout.write("\n");
                    resolve(value);
                    return;
                }
                if (char === "\u007f" || char === "\b") {
                    value = value.slice(0, -1);
                    continue;
                }
                if (char >= " ") value += char;
            }
        };
        const cleanup = () => {
            process.stdin.off("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
        };
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onData);
    });
}

function hashPassword(password) {
    if (password.length < 14 || password.length > 256) {
        throw new Error("Admin passwords must be between 14 and 256 characters.");
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function main() {
    const [command, username] = process.argv.slice(2);
    if (!["create", "reset-password"].includes(command)
        || !username
        || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
        throw new Error("Usage: node scripts/admin.js <create|reset-password> <username>");
    }
    const password = await readHidden("New password (minimum 14 characters): ");
    const confirmation = await readHidden("Confirm password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const encoded = hashPassword(password);
    if (command === "create") {
        await pool.query(
            "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)",
            [username, encoded],
        );
        console.log(`Administrator ${username} created.`);
    } else {
        const result = await pool.query(
            "UPDATE admin_users SET password_hash = $1, updated_at = now() WHERE username = $2",
            [encoded, username],
        );
        if (!result.rowCount) throw new Error(`No administrator named ${username} exists.`);
        await pool.query("DELETE FROM admin_sessions WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = $1)", [username]);
        console.log(`Password updated for ${username}. All existing admin sessions were revoked.`);
    }
}

main()
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
