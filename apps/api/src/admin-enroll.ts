/**
 * `bun run admin:enroll <username> [--name "Display Name"]` — mints a
 * single-use enrollment code (spec 0001 §8.1.2).
 *
 * This is both the bootstrap ("there are no admins yet, so nobody can authorize
 * one") and the recovery path research §7 requires for the day every credential
 * is lost. It works with the service running or stopped and takes no
 * authentication: filesystem access to the database *is* the authorization —
 * anything this refuses could be done with `sqlite3` and one UPDATE.
 *
 * It deliberately does not go through `getEnv()`: recovery must not depend on
 * the WebAuthn variables being set correctly, which is exactly the kind of
 * thing that may be broken when you need this.
 */
import { createDb, createRepos, openDb, runMigrations } from "./db";
import { PERMISSIONS } from "./service/permissions";

const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const CODE_LENGTH = 32;
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const USERNAME_RE = /^[a-z0-9-]{1,32}$/;

function mintCode(): string {
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

function parseArgs(argv: string[]): { username: string; name: string | undefined } {
  const [username, ...rest] = argv;
  if (username === undefined || !USERNAME_RE.test(username)) {
    console.error('usage: admin:enroll <username> [--name "Display Name"]');
    console.error("       username must match [a-z0-9-]{1,32}");
    process.exit(1);
  }
  let name: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--name") {
      name = rest[index + 1];
      index += 1;
    }
  }
  return { username, name };
}

const { username, name } = parseArgs(process.argv.slice(2));
const path = process.env.DATABASE_PATH ?? "./data/lever.db";

const sqlite = openDb(path);
runMigrations(sqlite);
const repos = createRepos(createDb(sqlite));

let account = await repos.adminAccounts.getByUsername(username);
let created = false;
if (account === undefined) {
  account = await repos.adminAccounts.create({ username, name: name ?? username });
  // Every permission: see the authorization note above — withholding grants here
  // would be ceremony, not security, and an account with none cannot log in.
  await repos.adminAccounts.replaceGrants(account.id, [...PERMISSIONS]);
  created = true;
} else if (name !== undefined) {
  await repos.adminAccounts.update(account.id, { name });
}

const code = mintCode();
const expiresAt = Date.now() + ENROLLMENT_TTL_MS;
await repos.adminAccounts.createEnrollment({
  accountId: account.id,
  codeHash: new Bun.CryptoHasher("sha256").update(code).digest("hex"),
  expiresAt,
});
sqlite.close();

console.log(`${created ? "created" : "found"} account "${username}"`);
if (created) console.log(`granted: ${PERMISSIONS.join(", ")}`);
console.log(`\nenrollment code (shown once, valid 15 minutes):\n\n  ${code}\n`);
console.log("Redeem it in the dashboard's passkey registration screen.");
