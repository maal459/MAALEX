# MAALEX — Operations Guide

Two things you need to operate this product:

1. [License generation](#1-license-generation)
2. [Publishing the mobile app](#2-publishing-the-mobile-app)

There is **no backend**. The app talks to Telesom's MyMerchant API directly through an in-app WebView, so the user's phone is the originating client. License verification is offline (Ed25519).

Keep this file updated whenever any of the two changes.

---

## 1. License generation

Licenses are signed with an Ed25519 keypair. The public key is embedded in the app (`services/licensing.js`); the private key lives only in `tools/issue-license.js`.

### Issue a license

Get the customer's device ID from the License screen in the app, then run:

```powershell
npm run issue-license -- <deviceId> [days] [tier] [label]
```

Examples:

```powershell
npm run issue-license -- lrfq3k-abc123def456 365
npm run issue-license -- lrfq3k-abc123def456 30 full "Abdi Shop"
npm run issue-license -- "*" 365 full "Floating key (no device binding)"
```

Send the resulting `MAALEX.xxx.xxx` string to the customer. They paste it into the Activate field on the License screen.

### Trial

First run starts a local 3-day trial automatically (no key needed). When it expires, the License screen blocks further use until a key is entered.

### Rotating keys

If the private key in `tools/issue-license.js` is ever exposed, generate a new keypair and replace `PUBLIC_KEY_HEX` in both `services/licensing.js` and `tools/issue-license.js`. All previously issued keys become invalid — plan a coordinated app update.

Generate a new keypair:

```powershell
node -e "const ed=require('@noble/ed25519');const{sha512}=require('@noble/hashes/sha2');ed.utils.sha512Sync=(...m)=>{const h=sha512.create();for(const x of m)h.update(x);return h.digest()};const priv=ed.utils.randomPrivateKey();const pub=ed.sync.getPublicKey(priv);console.log('PRIVATE:',Buffer.from(priv).toString('hex'));console.log('PUBLIC :',Buffer.from(pub).toString('hex'))"
```

---

## 2. Publishing the mobile app

### One-time

```powershell
npm install -g eas-cli
eas login
eas init
```

`app.json` already has the bundle id (`com.abdiwahab.maalex`) and version. Bump `version` and `versionCode`/`buildNumber` for every release.

### Build

```powershell
npm run build:android   # → AAB upload artifact for Play Store
npm run build:ios       # → IPA for App Store / TestFlight
```

For internal QA APKs:

```powershell
eas build --platform android --profile preview
```

### Submit

After the build finishes:

```powershell
npm run submit:android
npm run submit:ios
```

You'll need:

- Google Play: a service-account JSON with Play Console publishing rights, configured via `eas credentials`.
- Apple: an App Store Connect API key, also via `eas credentials`.

### Versioning checklist

Before each release:

- [ ] Bump `version` in `app.json` (semver).
- [ ] Bump `android.versionCode` and `ios.buildNumber` in `app.json` — must monotonically increase.
- [ ] Update `version` in `package.json` to match.
- [ ] Smoke-test sign-in → OTP → balance → auto-transfer flow on a real device.
- [ ] Smoke-test Reports screen against a fresh Telesom account.
