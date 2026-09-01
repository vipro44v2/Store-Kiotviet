import { generateTotpSecret, totpAuthUri } from "../lib/auth/totp.ts";

const account = process.argv[2]?.trim() || "admin";
const issuer = process.argv[3]?.trim() || "Shopify KiotViet Sync";
const secret = generateTotpSecret();
process.stdout.write(`ADMIN_TOTP_SECRET=${secret}\n`);
process.stdout.write(`${totpAuthUri(secret, account, issuer)}\n`);
