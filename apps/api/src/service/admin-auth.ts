/**
 * The §8.1 identity service: enrollment codes, the passkey ceremonies, sessions,
 * and grants. Every authentication failure leaves here as the same generic 401
 * — distinguishing "no such account" from "bad assertion" would leak exactly
 * what the generic response protects (§8.1.3).
 */
import type { AdminAccount, AdminCredential } from "../db/admin-account-repo";
import type { AdminSession } from "../db/admin-session-repo";
import { withTransaction, type Db, type Repos } from "../db";
import { LeverError, notFound } from "../error";
import { getLogger } from "../logger";
import { isPermission, type Permission } from "./permissions";
import type { TokenService } from "./tokens";
import type {
  AuthenticationResponseInput,
  RegistrationResponseInput,
} from "../api/admin/passkey-schemas";
import type { WebAuthnService } from "./webauthn";

const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const SESSION_SWEEP_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_LENGTH = 32;
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface AdminIdentity {
  account: AdminAccount;
  permissions: Permission[];
  sessionId: string;
}

export interface AccountView {
  id: string;
  username: string;
  name: string;
  createdAt: number;
  disabled: boolean;
  permissions: Permission[];
  credentialCount: number;
}

export interface IssuedSession {
  token: string;
  expiresAt: number;
  account: AccountView;
}

export interface EnrollmentTicket {
  code: string;
  expiresAt: number;
}

export interface AdminAuthService {
  /** Resolves a bearer token to a live identity, or `undefined` (§8.1.4). */
  authenticate(token: string): Promise<AdminIdentity | undefined>;

  startRegistration(code: string): Promise<{ challengeId: string; options: unknown }>;
  finishRegistration(input: {
    code: string;
    challengeId: string;
    credentialName: string;
    response: RegistrationResponseInput;
    ip: string | null;
    userAgent: string | null;
  }): Promise<IssuedSession>;

  startLogin(username: string | undefined): Promise<{ challengeId: string; options: unknown }>;
  finishLogin(input: {
    challengeId: string;
    response: AuthenticationResponseInput;
    ip: string | null;
    userAgent: string | null;
  }): Promise<IssuedSession>;

  logout(sessionId: string): Promise<void>;

  listAccounts(): Promise<AccountView[]>;
  getAccount(id: string): Promise<AccountView>;
  createAccount(input: {
    username: string;
    name: string;
    permissions: Permission[];
  }): Promise<{ account: AccountView; enrollment: EnrollmentTicket }>;
  updateAccount(
    id: string,
    input: { name?: string | undefined; disabled?: boolean | undefined },
  ): Promise<AccountView>;
  deleteAccount(id: string): Promise<void>;
  mintEnrollment(accountId: string): Promise<EnrollmentTicket>;
  replaceGrants(actor: AdminIdentity, id: string, permissions: Permission[]): Promise<AccountView>;

  listCredentials(accountId: string): Promise<AdminCredential[]>;
  removeCredential(accountId: string, credentialId: string): Promise<void>;
  listSessions(accountId: string): Promise<AdminSession[]>;
  revokeSession(sessionId: string): Promise<void>;

  /** Boot-time housekeeping; returns the number of rows dropped. */
  sweepExpiredSessions(): Promise<number>;
}

export function unauthorized(): LeverError {
  return new LeverError(401, "unauthorized", "authentication failed");
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Rejection sampling, unlike the client key's plain modulo (`environment-repo`):
 * an enrollment code *is* a credential for its 15-minute life, so its entropy
 * has to be the full 32 × log2(62) bits with no skew toward the low alphabet.
 */
function mintEnrollmentCode(): string {
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

export function createAdminAuthService(
  db: Db,
  repos: Repos,
  webauthn: WebAuthnService,
  tokens: TokenService,
  options: { sessionHours: number },
): AdminAuthService {
  const sessionTtlMs = options.sessionHours * 60 * 60 * 1000;

  const toView = async (account: AdminAccount): Promise<AccountView> => {
    const [permissions, credentials] = await Promise.all([
      repos.adminAccounts.listGrants(account.id),
      repos.adminAccounts.listCredentials(account.id),
    ]);
    return {
      id: account.id,
      username: account.username,
      name: account.name,
      createdAt: account.createdAt,
      disabled: account.disabledAt !== null,
      permissions: permissions.filter((entry) => isPermission(entry)),
      credentialCount: credentials.length,
    };
  };

  const requireAccount = async (id: string): Promise<AdminAccount> => {
    const account = await repos.adminAccounts.getById(id);
    if (account === undefined) throw notFound("account");
    return account;
  };

  const issueSession = async (
    account: AdminAccount,
    ip: string | null,
    userAgent: string | null,
  ): Promise<IssuedSession> => {
    // The row id is the token's jti, so both are minted together.
    const sessionId = Bun.randomUUIDv7();
    const expiresAt = Date.now() + sessionTtlMs;
    await repos.adminSessions.create({
      id: sessionId,
      accountId: account.id,
      expiresAt,
      ip,
      userAgent,
    });
    const token = await tokens.sign({ accountId: account.id, sessionId, expiresAt });
    getLogger().withMetadata({ username: account.username }).info("admin session issued");
    return { token, expiresAt, account: await toView(account) };
  };

  const mintCodeFor = async (accountId: string): Promise<EnrollmentTicket> => {
    const code = mintEnrollmentCode();
    const expiresAt = Date.now() + ENROLLMENT_TTL_MS;
    await repos.adminAccounts.createEnrollment({ accountId, codeHash: hash(code), expiresAt });
    return { code, expiresAt };
  };

  return {
    async authenticate(token) {
      const claims = await tokens.verify(token);
      if (claims === undefined) return undefined;
      // A valid signature is not authorization: the row is what logout, expiry,
      // and an admin revoking a device actually change.
      const session = await repos.adminSessions.findLiveById(claims.jti, Date.now());
      if (session === undefined || session.accountId !== claims.sub) return undefined;
      const account = await repos.adminAccounts.getById(session.accountId);
      if (account === undefined || account.disabledAt !== null) return undefined;
      // Resolved live, never carried in the token: a revoked grant applies on the
      // next request, and an account stripped of every grant is no longer an admin.
      const permissions = (await repos.adminAccounts.listGrants(account.id)).filter((entry) =>
        isPermission(entry),
      );
      if (permissions.length === 0) return undefined;
      return { account, permissions, sessionId: session.id };
    },

    async startRegistration(code) {
      const enrollment = await repos.adminAccounts.findLiveEnrollment(hash(code), Date.now());
      if (enrollment === undefined) throw unauthorized();
      const account = await repos.adminAccounts.getById(enrollment.accountId);
      if (account === undefined || account.disabledAt !== null) throw unauthorized();
      const existing = await repos.adminAccounts.listCredentials(account.id);
      return webauthn.startRegistration({
        account: { id: account.id, username: account.username, name: account.name },
        excludeCredentials: existing.map((credential) => ({
          id: credential.id,
          transports: credential.transports,
        })),
      });
    },

    async finishRegistration({ code, challengeId, credentialName, response, ip, userAgent }) {
      const codeHash = hash(code);
      const now = Date.now();
      const enrollment = await repos.adminAccounts.findLiveEnrollment(codeHash, now);
      if (enrollment === undefined) throw unauthorized();

      const verified = await webauthn.verifyRegistration({ challengeId, response });
      // The challenge is bound to the account it was issued for, so a code for
      // one account cannot redeem a ceremony started for another.
      if (verified === undefined || verified.accountId !== enrollment.accountId) {
        throw unauthorized();
      }

      // Consume before storing: the guarded update is what makes a code single-use
      // under concurrency, and losing that race must not still yield a credential.
      if (!(await repos.adminAccounts.consumeEnrollment(enrollment.id, now))) throw unauthorized();

      const account = await requireAccount(enrollment.accountId);
      await repos.adminAccounts.addCredential({
        id: verified.credential.id,
        accountId: account.id,
        publicKey: verified.credential.publicKey,
        counter: verified.credential.counter,
        transports: verified.credential.transports,
        name: credentialName,
      });
      getLogger().withMetadata({ username: account.username }).info("passkey enrolled");
      return issueSession(account, ip, userAgent);
    },

    async startLogin(username) {
      // Never an oracle: an unknown username yields the same options as a known
      // one, only without an allowCredentials hint (§8.1.3).
      let allowCredentials: { id: string; transports: string[] }[] = [];
      if (username !== undefined) {
        const account = await repos.adminAccounts.getByUsername(username);
        if (account !== undefined && account.disabledAt === null) {
          const credentials = await repos.adminAccounts.listCredentials(account.id);
          allowCredentials = credentials.map((credential) => ({
            id: credential.id,
            transports: credential.transports,
          }));
        }
      }
      return webauthn.startAuthentication({ allowCredentials });
    },

    async finishLogin({ challengeId, response, ip, userAgent }) {
      const stored = await repos.adminAccounts.getCredential(response.id);
      if (stored === undefined) throw unauthorized();

      const verified = await webauthn.verifyAuthentication({
        challengeId,
        response,
        credential: {
          id: stored.id,
          publicKey: stored.publicKey,
          counter: stored.counter,
          transports: stored.transports,
        },
      });
      if (verified === undefined) throw unauthorized();

      const account = await repos.adminAccounts.getById(stored.accountId);
      if (account === undefined || account.disabledAt !== null) throw unauthorized();
      const permissions = await repos.adminAccounts.listGrants(account.id);
      if (permissions.length === 0) throw unauthorized();

      await repos.adminAccounts.touchCredential(stored.id, verified.newCounter);
      return issueSession(account, ip, userAgent);
    },

    async logout(sessionId) {
      await repos.adminSessions.revoke(sessionId, Date.now());
    },

    async listAccounts() {
      const accounts = await repos.adminAccounts.list();
      return Promise.all(accounts.map(toView));
    },

    async getAccount(id) {
      return toView(await requireAccount(id));
    },

    async createAccount({ username, name, permissions }) {
      if ((await repos.adminAccounts.getByUsername(username)) !== undefined) {
        throw new LeverError(409, "conflict", `account "${username}" already exists`);
      }
      const account = await repos.adminAccounts.create({ username, name });
      await repos.adminAccounts.replaceGrants(account.id, permissions);
      const enrollment = await mintCodeFor(account.id);
      getLogger().withMetadata({ username }).info("admin account created");
      return { account: await toView(account), enrollment };
    },

    async updateAccount(id, input) {
      const updated = await withTransaction(db, async (trx) => {
        const account = await trx.adminAccounts.getById(id);
        if (account === undefined) throw notFound("account");
        const disabling = input.disabled === true && account.disabledAt === null;
        if (disabling) await guardLastManager(trx, id);

        const patch: { name?: string; disabledAt?: number | null } = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.disabled !== undefined) patch.disabledAt = input.disabled ? Date.now() : null;
        const row = await trx.adminAccounts.update(id, patch);
        if (row === undefined) throw notFound("account");
        // Disabling has to cut live access, not merely future logins.
        if (disabling) await trx.adminSessions.revokeAllForAccount(id, Date.now());
        return row;
      });
      return toView(updated);
    },

    async deleteAccount(id) {
      const username = await withTransaction(db, async (trx) => {
        const account = await trx.adminAccounts.getById(id);
        if (account === undefined) throw notFound("account");
        await guardLastManager(trx, id);
        await trx.adminAccounts.remove(id);
        return account.username;
      });
      getLogger().withMetadata({ username }).info("admin account deleted");
    },

    async mintEnrollment(accountId) {
      await requireAccount(accountId);
      return mintCodeFor(accountId);
    },

    async replaceGrants(actor, id, permissions) {
      await withTransaction(db, async (trx) => {
        const account = await trx.adminAccounts.getById(id);
        if (account === undefined) throw notFound("account");

        const losingManage =
          !permissions.includes("accounts:manage") &&
          (await trx.adminAccounts.listGrants(id)).includes("accounts:manage");
        if (losingManage) {
          if (actor.account.id === id) {
            throw new LeverError(
              409,
              "conflict",
              "an account cannot remove its own accounts:manage grant",
            );
          }
          await guardLastManager(trx, id);
        }
        await trx.adminAccounts.replaceGrants(id, permissions);
      });
      return toView(await requireAccount(id));
    },

    async listCredentials(accountId) {
      await requireAccount(accountId);
      return repos.adminAccounts.listCredentials(accountId);
    },

    async removeCredential(accountId, credentialId) {
      const credential = await repos.adminAccounts.getCredential(credentialId);
      if (credential === undefined || credential.accountId !== accountId) {
        throw notFound("credential");
      }
      await repos.adminAccounts.removeCredential(credentialId);
    },

    async listSessions(accountId) {
      await requireAccount(accountId);
      return repos.adminSessions.listByAccount(accountId);
    },

    async revokeSession(sessionId) {
      const session = await repos.adminSessions.getById(sessionId);
      if (session === undefined) throw notFound("session");
      await repos.adminSessions.revoke(sessionId, Date.now());
    },

    async sweepExpiredSessions() {
      return repos.adminSessions.deleteExpiredBefore(Date.now() - SESSION_SWEEP_AFTER_MS);
    },
  };
}

/**
 * §8.1.5: the last usable `accounts:manage` holder may not be removed. Callers
 * run this *inside* the same BEGIN IMMEDIATE transaction as their write — the
 * whole point is that two concurrent requests cannot each observe "two holders"
 * and then strip them both.
 */
async function guardLastManager(repos: Repos, targetId: string): Promise<void> {
  const grants = await repos.adminAccounts.listGrants(targetId);
  if (!grants.includes("accounts:manage")) return;
  if ((await repos.adminAccounts.countHolders("accounts:manage")) <= 1) {
    throw new LeverError(
      409,
      "conflict",
      "refusing to remove the last account holding accounts:manage",
    );
  }
}
