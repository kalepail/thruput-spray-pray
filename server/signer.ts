import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import type { Signer } from "@thruputchain/client";
import {
  CryptographicScheme,
  ed25519PublicKey,
  ed25519Signature,
} from "@thruputchain/protocol";

/** Public, deterministic test keys. Native crypto keeps signing off the JS curve implementation. */
export function demoSigner(index: number): Signer {
  const seed = createHash("sha256")
    .update(`spray-and-pray/local-demo/v1/${index}`)
    .digest();
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicBytes = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  return {
    publicKey: {
      scheme: CryptographicScheme.Ed25519,
      ed25519: ed25519PublicKey(publicBytes),
    },
    async sign(message) {
      return {
        scheme: CryptographicScheme.Ed25519,
        ed25519: ed25519Signature(sign(null, message, key)),
      };
    },
  };
}
