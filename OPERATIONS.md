# MAALEX — Operations Guide

Three things you need to operate this product:

1. [Backend deployment on Fly.io](#1-backend-deployment-on-flyio)
2. [License & trial system](#2-license--trial-system)
3. [Publishing the mobile app](#3-publishing-the-mobile-app)

Keep this file updated whenever any of the three changes.

---

## 1. Backend deployment on Fly.io

The backend is a Node.js Express app under `server/`. It proxies the Telesom merchant API and runs the auto-transfer monitor. It must stay online 24/7.

### 1.1 One-time setup

#### Install flyctl

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Close and reopen PowerShell so `flyctl` is on PATH.

#### Create Fly account + log in

```powershell
flyctl auth signup
# or
flyctl auth login
```

Fly requires a credit card to prevent abuse but does not auto-charge. A single always-on `shared-cpu-1x 256mb` VM costs roughly **$2/month**, which sits inside the bundled free credit, so the practical cost is **$0**.

#### Generate the production license secret

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Copy the output. You will use this in two places:

- As `LICENSE_SECRET` on the Fly app (so it validates keys).
- On your local machine when minting customer keys via `npm run issue-license`.

**Both must be the exact same value.** Keys minted with one secret will not validate against another. If you ever rotate the secret, every existing key becomes invalid — plan accordingly.

Save the secret in a password manager. Do **not** commit it to git.

### 1.2 First deploy

```powershell
cd C:\Users\Abdiwahab\Projects\MAALEX\server

flyctl launch --no-deploy
```

Answer the prompts:

| Prompt | Answer |
|---|---|
| App name | unique slug (e.g. `maalex-backend-<yourname>`) |
| Region | `fra` (Frankfurt — closest free region to Telesom) |
| PostgreSQL? | No |
| Redis? | No |
| Deploy now? | **No** — we still need to set the secret |

Edit `server/fly.toml` so the `app = "..."` line matches the slug you picked.

Set the secret:

```powershell
flyctl secrets set LICENSE_SECRET="<paste the 32-char secret you generated>"
```

Deploy:

```powershell
flyctl deploy
```

Wait about two minutes. Then verify:

```powershell
flyctl status
flyctl open /health
```

You should see `{"ok":true,"service":"maalex-zaad-backend"}` in the browser.

### 1.3 Day-to-day operations

| Task | Command |
|---|---|
| Tail logs in real time | `flyctl logs` |
| Restart the app | `flyctl machine restart` |
| Roll out new code | `git commit ... && flyctl deploy` |
| Open shell on the running VM | `flyctl ssh console` |
| Check resource usage | `flyctl status` |
| Update env var | `flyctl secrets set FOO=bar` (auto-redeploys) |
| List existing secrets | `flyctl secrets list` |
| Scale to one machine (recommended) | `flyctl scale count 1` |

### 1.4 Configuration variables

Set with `flyctl secrets set NAME=value`:

| Var | Required | Default | Purpose |
|---|---|---|---|
| `LICENSE_SECRET` | yes | — | HMAC secret for signing license keys. 32+ chars. |
| `PORT` | no | `4000` | Internal port. Fly's HTTP service maps 443 → 4000. |
| `ALLOWED_ORIGIN` | no | `*` | CORS allowlist. Tighten to your frontend's URL. |
| `SESSION_TTL_MINUTES` | no | `30` | Backend session lifetime (separate from Telesom's session). |

### 1.5 Pointing the mobile app at Fly

In the project root (`C:\Users\Abdiwahab\Projects\MAALEX\`), create `.env.local`:

```
EXPO_PUBLIC_ZAAD_BACKEND_URL=https://maalex-backend-<yourname>.fly.dev
```

Restart Expo to pick up the new env:

```powershell
npx expo start -c
```

The app will now talk to your Fly backend.

### 1.6 Why not free Render / Railway / Vercel?

- **Render free tier** spins down after 15 min of inactivity. The auto-transfer monitor would stop running when no one is using the app.
- **Railway** charges from minute one — no real free tier for an always-on service.
- **Vercel / Netlify** are serverless. Cold starts and rotating IPs break Telesom's session binding.

Fly with `auto_stop_machines = false` and `min_machines_running = 1` is the only "free-ish" option that keeps a process alive forever with a stable outbound IP.

---

## 2. License & trial system

The product gates access via **HMAC-signed self-validating license keys**. There is no database — every key carries its own expiration and is verified by the secret. Works perfectly on Fly's ephemeral filesystem.

### 2.1 Key shape

```
MAALEX-<base64url(payload)>-<base64url(sig)>
```

The payload is a JSON object: `{ t, iat, exp, dev, lbl }`

| Field | Meaning |
|---|---|
| `t` | tier — `"full"` or `"trial"` |
| `iat` | issued-at, epoch ms |
| `exp` | expires-at, epoch ms |
| `dev` | bound device ID, or `"*"` for any device |
| `lbl` | optional label (customer name) |

The signature is HMAC-SHA256 of the payload using `LICENSE_SECRET`, truncated to 16 bytes. Tampering with the payload invalidates the signature and the key is rejected.

### 2.2 Two kinds of keys

| Kind | When | Bound to | Lifetime |
|---|---|---|---|
| **Full** | Admin mints with CLI, gives to customer | Any device (`dev = "*"`) | You decide — typically 365 days |
| **Trial** | Backend auto-mints when user taps "Start 3-day free trial" | The device that requested it | 3 days fixed |

A trial key cannot be shared between devices because the device ID is baked into the signed payload, and the backend re-checks it on every request via the `x-maalex-device` header.

### 2.3 Minting full keys

Set the secret in your local PowerShell session (must match the production secret on Fly):

```powershell
$env:LICENSE_SECRET = "<paste the same secret you used on Fly>"
```

Then mint:

```powershell
cd C:\Users\Abdiwahab\Projects\MAALEX\server

# 1-year customer license
npm run issue-license -- --label "Acme Co" --days 365

# 14-day pilot
npm run issue-license -- --label "Pilot user" --days 14

# Device-locked admin key
npm run issue-license -- --label "Owner test" --days 730 --device "<your-device-id>"
```

Output:

```
License key:

  MAALEX-eyJ0...-aBc1...

Tier:       full
Issued:     2026-04-30T13:00:00.000Z
Expires:    2027-04-30T13:00:00.000Z
Device:     any (admin key)
Label:      Acme Co
```

Send the key string to the customer over a secure channel (the customer pastes it into the License screen on first launch).

### 2.4 Trial flow (no admin involvement)

1. User installs the app, opens it for the first time.
2. License screen appears — they tap **Start 3-day free trial**.
3. App generates a stable `deviceId`, calls `POST /api/license/trial`.
4. Backend mints a trial key, returns it.
5. App stores the key locally; the trial counts down for 3 days.
6. Once the trial expires, the License screen reappears with a "trial ended" message.

Backend rate-limits trial issuance to 1 request per device per 60 seconds (resets on backend restart — that's fine for our scale).

### 2.5 What happens when validation fails

| Server response | What the user sees |
|---|---|
| `Missing license key` | "Enter the license key your administrator gave you." |
| `Invalid license format` | Same as above. |
| `License signature mismatch` | Either tampered or signed with a different `LICENSE_SECRET`. |
| `License expired` / `Free trial has ended` | License screen reappears. |
| `License is bound to a different device` | Trial key from another phone. |

### 2.6 Revoking access

Self-validating tokens can't be individually revoked without a database. Two options:

1. **Wait for natural expiry.** If the customer's contract is one year, their key expires in one year.
2. **Rotate `LICENSE_SECRET`.** Invalidates **every** key. Then re-mint and re-issue to legitimate customers. Use this for emergency revocation.

```powershell
$new = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
flyctl secrets set LICENSE_SECRET="$new"
$env:LICENSE_SECRET = $new
# now re-mint keys for every active customer
```

If you need fine-grained revocation later, we can add a small revocation list (a single text file with revoked key prefixes, checked alongside HMAC verification).

### 2.7 Operations checklist

- [ ] Generated `LICENSE_SECRET` and saved in password manager.
- [ ] Set `LICENSE_SECRET` on Fly via `flyctl secrets set`.
- [ ] Set `$env:LICENSE_SECRET` locally before running `npm run issue-license`.
- [ ] Test mint a 1-day key, paste it into the app, confirm activation works.
- [ ] Test trial: tap **Start 3-day free trial**, confirm flow.

---

## 3. Publishing the mobile app

Goal: distribute the app **without using the public Google Play Store or Apple App Store**.

### 3.1 What we will use

| Platform | Channel | Audience size | Public listing? |
|---|---|---|---|
| Android | Direct APK download | Unlimited | No |
| iOS | TestFlight | Up to 10,000 testers | No (invite-only) |

TestFlight is technically Apple-hosted but is **not** the App Store — there's no public listing, no general search, no review for internal testers. It's the closest to "private distribution" Apple allows.

### 3.2 Prerequisites

| Item | Cost | Required for |
|---|---|---|
| EAS account (`eas-cli` from Expo) | Free | Both platforms |
| Apple Developer account | $99/year | iOS only |
| Android Keystore | Free (managed by EAS) | Android only |
| Domain name + HTTPS hosting | ~$15/year | Hosting the APK download page |

If you only need Android, you can ignore the Apple line.

### 3.3 First-time setup

```powershell
cd C:\Users\Abdiwahab\Projects\MAALEX
npm install -g eas-cli
eas login
```

Initialize EAS for this project:

```powershell
eas init
eas build:configure
```

This creates `eas.json`. Open it and confirm there are three profiles: `development`, `preview`, `production`. Make sure `production` produces an `.apk` for Android, not `.aab`:

```json
{
  "build": {
    "production": {
      "android": {
        "buildType": "apk"
      }
    }
  }
}
```

(Default is `.aab` which only Play Store uses. We want `.apk` for direct distribution.)

Verify `app.json` has stable identifiers:

```json
{
  "expo": {
    "name": "MAALEX",
    "slug": "maalex",
    "version": "1.0.0",
    "android": {
      "package": "com.yourcompany.maalex",
      "versionCode": 1
    },
    "ios": {
      "bundleIdentifier": "com.yourcompany.maalex",
      "buildNumber": "1"
    }
  }
}
```

**Never change `package` / `bundleIdentifier` once you ship** — users won't be able to update otherwise.

### 3.4 Building Android APK

```powershell
eas build --platform android --profile production
```

Wait 15–25 min. EAS gives you a download URL like `https://expo.dev/artifacts/eas/<id>.apk`.

Two ways to distribute:

**(a) Direct link.** Send the URL to your customers. They open it on their Android phone, accept "Install from unknown sources", install. Works but requires the user trusts you.

**(b) Hosted install page.** Upload the APK to your server (e.g., `https://maalex-backend-<yourname>.fly.dev/download/maalex-1.0.0.apk` if you serve static files, or any S3/Cloudflare R2 bucket). Make a tiny landing page with a download button and instructions. Better polish, same install flow.

### 3.5 Building for TestFlight (iOS)

You need an Apple Developer account ($99/yr) before any of this works.

```powershell
eas build --platform ios --profile production
eas submit --platform ios --latest
```

`eas submit` uploads the build to App Store Connect. After ~30 min, it appears in the **TestFlight** tab.

In App Store Connect:

1. Open your app → **TestFlight** tab → **Internal Testing**.
2. Add testers by Apple ID email (instant access, no review).
3. For external testers, create a public link under **External Testing**. Apple does a light "beta review" the first time — typically 24 hours.

Testers install the **TestFlight** app from the App Store, then your app via your invite link.

### 3.6 Updating after the first release

Bump versions before every build:

- `app.json` → bump `expo.version` (user-facing, e.g. `1.0.1`)
- `app.json` → increment `android.versionCode` and `ios.buildNumber` by **1** every build (must be strictly increasing)

Then re-run the build commands. EAS handles the rest.

For JS-only changes (no native code touched), you can use **EAS Update** to push changes over-the-air without rebuilding:

```powershell
eas update --branch production --message "Fix balance display bug"
```

The next time the user opens the app, the new JS bundle downloads silently. Native changes still require a full rebuild.

### 3.7 What the user does to install

**Android (direct APK):**
1. Open the install URL on the phone.
2. Accept "Install from unknown sources" the first time (Settings prompt).
3. Tap **Install**.
4. Open the app. Activate license or start trial.

**iOS (TestFlight):**
1. Receive your invite email or link.
2. Install the **TestFlight** app from the App Store.
3. Tap the invite link → **Accept** → **Install** the app.
4. Open the app. Activate license or start trial.

### 3.8 Why not Google Play Store?

Even though you have an account:

- Google Play has a **Financial Services policy** that requires disclosure of regulator affiliation and can demand proof you are an authorized Telesom partner. Without that, the listing risks rejection or removal.
- Storing the transaction PIN in AsyncStorage may flag automated security scans on Play.
- A removal under policy violation puts a strike on your developer account. Three strikes = permanent ban tied to your identity and payment details.

Direct APK distribution avoids all of these, at the cost of users having to enable "unknown sources" once.

If you change your mind later, the same EAS build can be re-targeted to Play Store with `eas submit --platform android` — the only thing you'd need to switch is the `buildType` from `"apk"` to `"app-bundle"` in `eas.json`.

---

## Quick command reference

### Backend

```powershell
# Local dev
cd server
$env:LICENSE_SECRET = "<dev secret>"
npm run dev

# Mint a key
npm run issue-license -- --label "Customer" --days 365

# Deploy
flyctl deploy
flyctl logs
flyctl status

# Rotate the secret (invalidates all existing keys)
flyctl secrets set LICENSE_SECRET="$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"base64url\"))')"
```

### Mobile

```powershell
# Run locally
npx expo start -c

# Build & ship
eas build --platform android --profile production
eas build --platform ios --profile production
eas submit --platform ios --latest

# Push JS-only update
eas update --branch production --message "<changelog>"
```

---

## Disaster recovery

| Scenario | What to do |
|---|---|
| Fly app is down | `flyctl status` → if machine stopped, `flyctl machine start <id>`. Check `flyctl logs` for crash. |
| Lost the `LICENSE_SECRET` | You cannot recover. Set a new one (`flyctl secrets set`) and re-issue keys to every active customer. Old keys are dead forever. |
| Lost Apple Developer access | You can keep distributing existing TestFlight builds for ~30 days. Pay to renew or migrate the team. |
| Lost the Android signing keystore | EAS holds it for you (`eas credentials` to back it up). If you ever lose access AND EAS loses it, you cannot publish updates to the same package — you'd have to re-release under a new package name and ask users to reinstall. |
| Telesom changes their API | Logs will show non-2001 result codes. Re-run a fresh HAR capture, compare body shapes, patch `server/src/telesomApi.js`. The flat-body convention has been stable so far. |
