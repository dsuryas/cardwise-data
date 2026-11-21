// npm run keygen → prints a new signing key pair. Run once; never commit the private key.
import { generateKeys } from "./sign.ts";

const k = generateKeys();
console.log("1) Add this as the GitHub secret CATALOG_SIGNING_KEY (Settings → Secrets → Actions):\n");
console.log(k.privateKeyB64 + "\n");
console.log("2) Put this in the app's gradle.properties as cardwise.catalogPublicKey:\n");
console.log(k.publicKeyRawB64);
