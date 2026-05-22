---
title: Setting up two-factor authentication
category: Account & Security
tags: [2fa, security, account, authentication]
---

# Setting up two-factor authentication

Two-factor authentication (2FA) adds a second sign-in step so even if your password leaks, your account stays safe.

## Methods we support

- **Authenticator app** (recommended) — Google Authenticator, Authy, 1Password, etc.
- **SMS text code** — sent to your phone number.
- **Security key** — hardware keys (YubiKey, Titan) via WebAuthn.

Authenticator apps and security keys are more secure than SMS.

## Enable 2FA

1. Sign in and go to **Account → Security → Two-factor authentication**.
2. Click **Enable** and choose a method.
3. **Authenticator app:** scan the QR code in your app, then enter the 6-digit code to confirm.
   **SMS:** enter your phone number, then the code we text you.
   **Security key:** insert your key and follow the browser prompt.
4. **Save your recovery codes.** We show 10 one-time codes — store them somewhere safe (password manager, printed copy). Each works once if you lose access to your second factor.

## Signing in with 2FA

Enter your password as usual, then your 6-digit code (or tap your security key). On trusted devices, you can check **Remember this device for 30 days** to skip the second step for a month.

## Lost access to your second factor

1. Use a recovery code from when you set up 2FA.
2. If you've used all your codes, contact support with proof of identity (recent order number, billing ZIP, etc.). We disable 2FA after manual verification — usually within 24 hours.

## Disable 2FA

We don't recommend disabling 2FA, but you can: go to **Account → Security**, click **Disable**, and confirm with your password and a code.
