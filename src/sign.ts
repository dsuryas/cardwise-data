// Ed25519 signing of the published catalog. The private key lives only in the CATALOG_SIGNING_KEY
// GitHub secret; the app ships the matching public key and refuses anything it doesn't verify.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export function generateKeys(): { privateKeyB64: string; publicKeyRawB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyB64: (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
    publicKeyRawB64: rawPublic(publicKey).toString("base64"),
  };
}

export function rawPublic(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}

export function loadPrivateKey(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}

/** Signature over the exact bytes that will be served, base64-encoded. */
export function signBytes(bytes: Buffer, privateKeyB64: string): string {
  return sign(null, bytes, loadPrivateKey(privateKeyB64)).toString("base64");
}

export function verifyBytes(bytes: Buffer, signatureB64: string, publicKeyRawB64: string): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex"); // DER header for a raw Ed25519 key
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyRawB64, "base64")]), format: "der", type: "spki" });
  return verify(null, bytes, key, Buffer.from(signatureB64, "base64"));
}

export function publicKeyFromPrivate(privateKeyB64: string): string {
  return rawPublic(createPublicKey(loadPrivateKey(privateKeyB64))).toString("base64");
}
