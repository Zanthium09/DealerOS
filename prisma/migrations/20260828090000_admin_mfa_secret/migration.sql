-- AdminUser gets a per-admin TOTP secret (§9A.2). Encrypted at rest by the
-- application (AES-256-GCM, key derived from ADMIN_MFA_KEY), so this column
-- holds ciphertext, never a usable base32 secret.
ALTER TABLE "AdminUser" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN "mfaEnrolledAt" TIMESTAMP(3);
