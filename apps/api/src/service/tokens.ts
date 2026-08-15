/**
 * Admin session tokens (spec 0001 §8.1.4): a signed JWT whose `sub` is the
 * account and whose `jti` is the `admin_sessions` row id. The signature makes
 * the token self-describing; the row is what makes revoking it instant, so
 * both are checked on every request.
 *
 * HS256 over a single secret rather than the reference stack's RS256 keypair:
 * lever issues and verifies in the same process, so an asymmetric key would add
 * a JWK to generate, rotate, and mis-paste with no second verifier to serve.
 * Swapping algorithms is contained to this module.
 */
import * as jose from "jose";
import { z } from "zod";

const ISSUER = "lever";
const AUDIENCE = "urn:lever:admin";
const CLOCK_TOLERANCE_SECONDS = 30;

const claimsSchema = z.object({ sub: z.string().min(1), jti: z.string().min(1) });

export type AdminTokenClaims = z.infer<typeof claimsSchema>;

export interface TokenService {
  sign(input: { accountId: string; sessionId: string; expiresAt: number }): Promise<string>;
  /** `undefined` for anything unverifiable — bad signature, wrong audience, expired. */
  verify(token: string): Promise<AdminTokenClaims | undefined>;
}

export function createTokenService(secret: string): TokenService {
  const key = new TextEncoder().encode(secret);

  return {
    async sign({ accountId, sessionId, expiresAt }) {
      return (
        new jose.SignJWT({})
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(accountId)
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          // Seconds, matching the row's millisecond `expires_at` — the row is
          // authoritative; this just stops an expired token reaching the lookup.
          .setExpirationTime(Math.floor(expiresAt / 1000))
          .setJti(sessionId)
          .sign(key)
      );
    },

    async verify(token) {
      try {
        const { payload } = await jose.jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ["HS256"],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        const parsed = claimsSchema.safeParse(payload);
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
