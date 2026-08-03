# Stripe Email License Automation

This folder contains a Google Apps Script mailer that polls Gmail every five minutes, looks for Stripe sale or renewal emails, generates a signed 30-day license file, and emails the `.lic` file to the customer.

## Files

- `stripe-license-mailer.gs`: paste this into a Google Apps Script project.

## Setup

1. Generate the RSA key pair:

   ```powershell
   node scripts/generate-google-license-keys.mjs
   ```

2. Copy the private key from:

   ```txt
   secrets/licenses/byteforge-license-rsa-private-key.pem
   ```

3. Paste it into `CONFIG.privateKeyPem` at the top of `stripe-license-mailer.gs` inside Google Apps Script.

4. Set `CONFIG.adminEmail` and `CONFIG.replyToEmail`.

5. Tune `CONFIG.stripeSearchQuery` after inspecting your real Stripe receipt emails.

6. Run `installFiveMinuteTrigger()` once in Apps Script and approve the requested permissions.

The private key must not be committed. The public key in `assets/licenses/` is safe to ship with the plugin so licenses can be verified locally.

## License Format

The generated license file contains:

- `payload`: license claims such as product, license ID, customer hash, valid-until date, and Stripe source reference.
- `signature`: RS256 signature over canonical JSON for `payload`.

The plugin should verify the signature with `assets/licenses/byteforge-license-rsa-public-key.pem`, then enforce `validUntil` and `graceUntil`.
