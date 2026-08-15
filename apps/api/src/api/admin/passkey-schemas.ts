/**
 * Zod schemas for the WebAuthn payloads the browser posts back (§8.1.2, §8.1.3),
 * plus the adapters that turn a validated shape into @simplewebauthn's exact
 * JSON types. The adapters exist because `exactOptionalPropertyTypes` makes
 * `{ x?: T | undefined }` (what zod infers) distinct from `{ x?: T }` (what the
 * library declares) — a conditional spread bridges them without a cast.
 */
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";

const base64url = z.string().min(1).max(4096);

const transport = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

export const registrationResponseSchema = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    transports: z.array(transport).max(8).optional(),
  }),
});

export const authenticationResponseSchema = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.optional(),
  }),
});

export type RegistrationResponseInput = z.infer<typeof registrationResponseSchema>;
export type AuthenticationResponseInput = z.infer<typeof authenticationResponseSchema>;

export function toRegistrationResponseJSON(
  input: RegistrationResponseInput,
): RegistrationResponseJSON {
  return {
    id: input.id,
    rawId: input.rawId,
    type: input.type,
    // Never forwarded from the client: extension outputs are advisory, and none
    // of the verification below reads them.
    clientExtensionResults: {},
    ...(input.authenticatorAttachment === undefined
      ? {}
      : { authenticatorAttachment: input.authenticatorAttachment }),
    response: {
      clientDataJSON: input.response.clientDataJSON,
      attestationObject: input.response.attestationObject,
      ...(input.response.transports === undefined ? {} : { transports: input.response.transports }),
    },
  };
}

export function toAuthenticationResponseJSON(
  input: AuthenticationResponseInput,
): AuthenticationResponseJSON {
  return {
    id: input.id,
    rawId: input.rawId,
    type: input.type,
    clientExtensionResults: {},
    ...(input.authenticatorAttachment === undefined
      ? {}
      : { authenticatorAttachment: input.authenticatorAttachment }),
    response: {
      clientDataJSON: input.response.clientDataJSON,
      authenticatorData: input.response.authenticatorData,
      signature: input.response.signature,
      ...(input.response.userHandle === undefined ? {} : { userHandle: input.response.userHandle }),
    },
  };
}

/** Stored transports are TEXT; only the values the spec knows reach the browser. */
export function toTransports(values: string[]): AuthenticatorTransportFuture[] {
  return values.filter(
    (value): value is AuthenticatorTransportFuture => transport.safeParse(value).success,
  );
}
