/**
 * The passkey ceremonies (spec 0001 §8.1.2, §8.1.3) over
 * `@simplewebauthn/server`. Challenges live in process memory with a short TTL,
 * consistent with the rest of the single-process design (§9.4): a restart
 * invalidates in-flight ceremonies, which costs one retried prompt.
 *
 * The interface is the seam tests substitute — a WebAuthn double lets the
 * §10.3 ceremony coverage exercise enrollment, login, replay, and expiry
 * without real authenticator cryptography.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  toAuthenticationResponseJSON,
  toRegistrationResponseJSON,
  toTransports,
  type AuthenticationResponseInput,
  type RegistrationResponseInput,
} from "../api/admin/passkey-schemas";
import { getLogger } from "../logger";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface CredentialDescriptor {
  id: string;
  transports: string[];
}

export interface StoredCredential {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

export interface VerifiedCredential {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

export interface WebAuthnService {
  // `options` is an opaque blob forwarded to the browser verbatim — typing it
  // here would buy nothing and would make the test double reconstruct a full
  // WebAuthn options object to say "the ceremony started".
  startRegistration(input: {
    account: { id: string; username: string; name: string };
    excludeCredentials: CredentialDescriptor[];
  }): Promise<{ challengeId: string; options: unknown }>;
  /** `undefined` on any failure — callers map every one to the same generic 401. */
  verifyRegistration(input: {
    challengeId: string;
    response: RegistrationResponseInput;
  }): Promise<{ accountId: string; credential: VerifiedCredential } | undefined>;
  startAuthentication(input: {
    allowCredentials: CredentialDescriptor[];
  }): Promise<{ challengeId: string; options: unknown }>;
  verifyAuthentication(input: {
    challengeId: string;
    response: AuthenticationResponseInput;
    credential: StoredCredential;
  }): Promise<{ newCounter: number } | undefined>;
}

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origins: string[];
}

export type Ceremony = "register" | "login";

export interface PendingChallenge {
  ceremony: Ceremony;
  challenge: string;
  accountId: string | undefined;
  expiresAt: number;
}

/**
 * Single-use, TTL'd, and tagged with the ceremony that created it — a login
 * challenge can never be redeemed as a registration, which is what keeps the
 * two flows from being replayed into each other (§8.1.3).
 */
export class ChallengeStore {
  private readonly pending = new Map<string, PendingChallenge>();

  put(ceremony: Ceremony, challenge: string, accountId?: string): string {
    this.sweep();
    const challengeId = Bun.randomUUIDv7();
    this.pending.set(challengeId, {
      ceremony,
      challenge,
      accountId,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return challengeId;
  }

  take(challengeId: string, ceremony: Ceremony): PendingChallenge | undefined {
    const entry = this.pending.get(challengeId);
    // Deleted on every hit, valid or not: one id is one attempt, so a failed
    // verification cannot be retried against the same challenge.
    this.pending.delete(challengeId);
    if (entry === undefined) return undefined;
    if (entry.ceremony !== ceremony) return undefined;
    if (entry.expiresAt <= Date.now()) return undefined;
    return entry;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
  }
}

export function createWebAuthnService(config: WebAuthnConfig): WebAuthnService {
  const store = new ChallengeStore();

  return {
    async startRegistration({ account, excludeCredentials }) {
      const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpId,
        userID: new TextEncoder().encode(account.id),
        userName: account.username,
        userDisplayName: account.name,
        attestationType: "none",
        excludeCredentials: excludeCredentials.map((credential) => ({
          id: credential.id,
          transports: toTransports(credential.transports),
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      return { challengeId: store.put("register", options.challenge, account.id), options };
    },

    async verifyRegistration({ challengeId, response }) {
      const pending = store.take(challengeId, "register");
      if (pending === undefined || pending.accountId === undefined) return undefined;

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: toRegistrationResponseJSON(response),
          expectedChallenge: pending.challenge,
          expectedOrigin: config.origins,
          expectedRPID: config.rpId,
          requireUserVerification: true,
        });
      } catch (error) {
        // The library throws on malformed or mismatched material; that is a
        // failed ceremony, not a server fault.
        getLogger().withError(error).warn("passkey registration verification failed");
        return undefined;
      }
      if (!verification.verified) return undefined;

      const { credential } = verification.registrationInfo;
      return {
        accountId: pending.accountId,
        credential: {
          id: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports ?? [],
        },
      };
    },

    async startAuthentication({ allowCredentials }) {
      const options = await generateAuthenticationOptions({
        rpID: config.rpId,
        userVerification: "required",
        allowCredentials: allowCredentials.map((credential) => ({
          id: credential.id,
          transports: toTransports(credential.transports),
        })),
      });
      return { challengeId: store.put("login", options.challenge), options };
    },

    async verifyAuthentication({ challengeId, response, credential }) {
      const pending = store.take(challengeId, "login");
      if (pending === undefined) return undefined;

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: toAuthenticationResponseJSON(response),
          expectedChallenge: pending.challenge,
          expectedOrigin: config.origins,
          expectedRPID: config.rpId,
          requireUserVerification: true,
          credential: {
            id: credential.id,
            // Copied into a fresh view: bun:sqlite hands back a Uint8Array over
            // an unspecified buffer kind, which does not satisfy the library's
            // stricter `Uint8Array<ArrayBuffer>`. A public key is ~65 bytes.
            publicKey: new Uint8Array(credential.publicKey),
            counter: credential.counter,
            transports: toTransports(credential.transports),
          },
        });
      } catch (error) {
        getLogger().withError(error).warn("passkey authentication verification failed");
        return undefined;
      }
      if (!verification.verified) return undefined;
      return { newCounter: verification.authenticationInfo.newCounter };
    },
  };
}
