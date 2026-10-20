import type { Signer } from "@thruputchain/client";
import {
  CryptographicScheme,
  ed25519PublicKey,
  ed25519Signature,
} from "@thruputchain/protocol";
import { base64UrlBytes, concatBytes, hexBytes } from "./bytes.js";

const PKCS8_ED25519_PREFIX = hexBytes("302e020100300506032b657004220420");

/** Public, deterministic test keys. Web Crypto keeps signing in native code. */
export async function demoSigner(index: number): Promise<Signer> {
  const seed = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`spray-and-pray/local-demo/v1/${index}`),
    ),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    concatBytes(PKCS8_ED25519_PREFIX, seed),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const { x } = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (!x) throw new Error("Ed25519 key export has no public key");
  return {
    publicKey: {
      scheme: CryptographicScheme.Ed25519,
      ed25519: ed25519PublicKey(base64UrlBytes(x)),
    },
    async sign(message) {
      return {
        scheme: CryptographicScheme.Ed25519,
        ed25519: ed25519Signature(
          new Uint8Array(
            await crypto.subtle.sign("Ed25519", key, message as BufferSource),
          ),
        ),
      };
    },
  };
}
