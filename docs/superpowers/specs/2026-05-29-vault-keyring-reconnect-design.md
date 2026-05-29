# Vault ↔ Keyring Reconnect & Recovery — Design

**Date:** 2026-05-29
**Status:** Approved (design); pending implementation plan
**Component:** `src/secrets/*`, `src/commands/*`, `scripts/install.sh`, `src/index.ts`

## Problem

The pi-engineering secrets vault (`~/.pi/engineering-team/secrets.db`) encrypts secret
values with a 32-byte master key. For the common setup, that key is **randomly
generated and stored only in the OS keychain** (macOS Keychain via
`@napi-rs/keyring`), under a static service/account (`pi-engineering` /
`secrets-master`).

This creates a single point of failure. In `MasterKey.ts` (`ensureInitialized`),
the keychain-first first-run path generates a random key and stores it *only* in
the keychain — **no passphrase salt and no backup are ever written**. The
passphrase/salt path runs *only* when there is no keychain backend at all. So a
keychain-first user has no recovery path. When keychain access is later lost, the
manager hard-fails:

> Vault exists at `<path>` but no master key in keyring and no passphrase salt at
> `<path>`. Restore the keyring entry, or delete the vault file to start fresh
> (DESTRUCTIVE — your stored secrets will be lost).

"Losing the connection" has two distinct causes:

- **Mode 1 — keychain entry still exists, just unreadable.** The native keyring
  addon (`keyring.<tag>.node`) fails to load after a Node version bump (ABI
  mismatch), before the user reinstalls. The master key is still in the Keychain;
  only the addon needs rebuilding. Recoverable automatically, no secret needed.
- **Mode 2 — keychain entry genuinely gone/inaccessible.** New machine or macOS
  user (the keychain entry is per-user, per-machine, and does **not** travel with
  the portable `secrets.db` file), a reset login keychain, or macOS ACL denial of
  a new binary. The key is unrecoverable **unless** an independent backup was
  established beforehand.

## Goals

1. Make Mode 1 produce an accurate diagnosis and the correct remediation
   (rebuild the keyring addon via `pnpm run engineering:install`).
2. Make Mode 2 recoverable by establishing an **independent, portable** backup of
   the master key, protected by a user passphrase.
3. Provide an explicit, interactive `/secret-reconnect` command that diagnoses
   the mode and performs the matching repair, including re-storing the recovered
   key into the keychain.
4. Keep the OS keychain as the zero-friction primary; the passphrase is only ever
   exercised during recovery.

## Non-goals

- Retroactively rescuing a vault that never had a backup enrolled. If the
  keychain entry is gone and no recovery blob/salt exists, those secrets are
  cryptographically unrecoverable; the user starts fresh. This feature prevents
  the *next* occurrence.
- Enforcing passphrase strength policy (informational nudge only).
- In-process rebuilding of native addons (the bundle has no guaranteed build
  toolchain — same stance as the `better_sqlite3` install hardening).
- Recovery codes / second unlock factors (passphrase only, per decision).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Scope | Cover **both** Mode 1 and Mode 2 |
| Recovery secret | **Passphrase**, envelope-wrapping the existing random master key |
| Backup storage | **Inside the vault DB** (`vault_meta` table) — Approach A |
| Enrollment | Auto-prompt new vaults; **nag** existing keychain-only vaults; enrollment runs as an explicit interactive command |
| Command surface | Dedicated `/secret-reconnect`; `doctor` gets read-only checks pointing to it |
| Keychain re-store | Deferred to the explicit `/secret-reconnect` — startup may recover the *session* but never writes to the keychain silently |

## Architecture & data model

Envelope encryption: the random master key stays primary; a passphrase-derived
key (KEK) wraps a copy of it. The wrapped copy lives in the vault's `vault_meta`
table, which is plaintext key/value `TEXT` (only secret *values* are encrypted),
so it is readable without the master key — including on a fresh machine after the
`secrets.db` file is copied over.

### `vault_meta` recovery rows

| key | value |
|---|---|
| `recovery_salt` | hex, 16 bytes |
| `recovery_wrap` | hex, AES-256-GCM ciphertext of the master key |
| `recovery_iv` | hex, 12 bytes |
| `recovery_tag` | hex, GCM auth tag |
| `recovery_kdf` | `scrypt-N32768-r8-p1` (versioned for future migration) |
| `recovery_enrolled_at` | epoch ms |

### New / changed units

- **`Crypto.ts`** (extend): `wrapMasterKey(masterKey, passphrase, salt) → {wrap, iv, tag}`
  and `unwrapMasterKey(wrap, iv, tag, passphrase, salt) → masterKey`. Thin
  wrappers over the existing `encrypt`/`decrypt` (AES-256-GCM) and
  `deriveKeyFromPassphrase` (scrypt). No new algorithms.
- **`Vault.ts`** (extend), none requiring the master key for reads:
  `hasRecoveryBackup(): boolean`, `readRecoveryBlob(): RecoveryBlob | null`,
  `writeRecoveryBlob(blob): void` (single transaction).
- **`MasterKeyManager.ts`** (extend): `enrollRecovery(passphrase)`; new recovery
  branch in `ensureInitialized()`; Mode 1 vs Mode 2 distinction.
- **`Keyring.ts`** (extend): add `diagnoseKeyring(): { status: "ok" | "load-failed" | "locked" | "unavailable"; detail?: string }`,
  used only by `/secret-reconnect` and `doctor`. The existing `createKeyringBackend(): KeyringBackend | null`
  contract is unchanged for the hot path.
- **`src/commands/secret-setup-recovery.ts`** (new): interactive enrollment.
- **`src/commands/secret-reconnect.ts`** (new): interactive diagnosis + repair.
- **`src/commands/doctor.ts`** (extend): read-only vault/recovery checks.
- **`scripts/install.sh`** (extend): keyring addon smoke-test.
- **`src/index.ts`** (extend): startup nag.

Dependency direction stays clean: `Crypto` (leaf) ← `Vault` ← `MasterKeyManager`
← commands. The recovery blob is the only new shared contract, owned by `Vault`.

## Flows

### A. Enrollment (`/secret-setup-recovery`, and auto on new-vault first run)

Precondition: vault is unlocked (master key in hand).

1. Prompt passphrase (with confirm).
2. `salt = generateSalt()`; `KEK = scrypt(passphrase, salt)`.
3. `{wrap, iv, tag} = encrypt(masterKey, KEK)`.
4. `vault.writeRecoveryBlob({salt, wrap, iv, tag, kdf, enrolled_at})`.
5. Confirm enrollment to the user.

- New-vault path: after `generateMasterKey()` + keychain store, run enrollment
  **if** an interactive prompt is available; if headless (no TTY), skip and let
  the nag catch it later.
- Re-enrollment is idempotent (overwrites the blob); this doubles as "change
  recovery passphrase."

### B. Reconnect (`/secret-reconnect`) — diagnose first, then matching repair

```
1. diagnoseKeyring()
   ├─ load-failed → MODE 1
   ├─ locked      → "unlock Keychain & retry"; no change
   ├─ unavailable → report; no change
   └─ ok          → query keychain entry
        ├─ "value"     → already healthy; report, exit
        ├─ "error"     → "unlock Keychain & retry"; no change
        └─ "not-found" → MODE 2

MODE 1 (addon ABI mismatch — key still in Keychain):
   - Report Node version + ABI; remediation:
       nvm use 22 && pnpm rebuild && pnpm run engineering:install
   - No secret prompt; no writes. Keychain key is intact; reinstall restores it.

MODE 2 (keychain entry gone):
   - Open vault DB (no key needed); read recovery blob.
   - No blob → honest dead-end: secrets unrecoverable; start fresh or restore Keychain.
   - Blob present:
       a. Prompt recovery passphrase.
       b. KEK = scrypt(passphrase, blob.salt); masterKey = decrypt(blob.wrap, KEK, iv, tag).
       c. Validate via vault.verifyDecryptable(); mismatch → "Passphrase did not match" (retry, no change).
       d. If keyring addon available → backend.set(SERVICE, ACCOUNT, masterKey.hex)  ← the reconnect.
          If no addon → warn: session recovered but can't persist (Mode 1 also present).
       e. Confirm: master key restored to the Keychain.
```

### C. Startup nag (`index.ts`)

When `ensureInitialized()` succeeds **via the keychain** and
`vault.hasRecoveryBackup()` is false, emit once per process:

> [pi-engineering] No vault recovery passphrase enrolled — if this machine's
> keychain is lost you cannot recover stored secrets. Run `/secret-setup-recovery`.

Silent in passphrase-mode, empty/no vault, or when a blob already exists.

### D. `MasterKeyManager.ensureInitialized()` updated precedence

```
keychain "value"                         → use it                         (unchanged)
keychain "error"                         → throw "unlock keyring"          (unchanged)
keychain "not-found"/no-addon + vault exists:
    → vault_meta recovery blob? prompt passphrase → unwrap → validate      (NEW)
    → else legacy saltPath?     prompt passphrase → derive                 (existing)
    → else                      fail-closed (DESTRUCTIVE message)          (existing)
vault absent                             → first-run (keychain generate + auto-enroll,
                                            or passphrase mode)
```

Startup may recover the **session** via the recovery blob, but **re-storing into
the keychain happens only in `/secret-reconnect`** (explicit, interactive). No
surprise keychain writes during agent runs.

**Mode 1 at startup (intended, not a bug):** `ensureInitialized()` consumes the
existing `createKeyringBackend()` contract, which returns `null` for *any* addon
load failure. So a Mode 1 (ABI) failure at startup is indistinguishable from
not-found *to this hot path* and flows into the recovery-blob branch — i.e. it
prompts for the recovery passphrase if interactive, or fails closed if headless.
That is acceptable: the session still recovers when a blob + passphrase exist.
The accurate Mode 1 diagnosis ("rebuild the addon") is surfaced by the
`diagnoseKeyring()`-powered `/secret-reconnect` and `doctor`, which the
fail-closed message and nag point the user toward.

## Error handling & security

### Security tradeoff (stated plainly)

Enrolling a recovery passphrase lowers the vault's security floor from
"keychain-only (very strong, hardware-backed)" to "the **weaker** of {keychain,
scrypt(passphrase)}." Anyone with the `secrets.db` file **and** the passphrase can
recover — that is the intended portability. Mitigations: keychain remains
primary; passphrase only exercised during recovery; scrypt is tuned
(N=32768, r=8, p=1); the enrollment confirmation states the tradeoff; no policy
enforcement (informational nudge only).

### Crypto hygiene

- `zeroBuffer` the KEK and any transient master-key copy in `finally` blocks.
- Never log passphrase or key material; prompts go through `readHidden`.
- `writeRecoveryBlob` writes all six rows in one transaction (no partial blob).

### Correctness gates on unwrap (defense in depth)

1. AES-GCM auth tag is the real gate — wrong passphrase makes `decrypt` throw.
2. `verifyDecryptable()` confirms the unwrapped key matches this vault's rows.
- **Empty vault**: `verifyDecryptable()` is vacuously `true`; gate #1 (GCM tag) is
  what validates the passphrase. Pinned by a test.

### Error taxonomy

| Condition | Detection | Message / action |
|---|---|---|
| Mode 1: addon load failure | `diagnoseKeyring() = load-failed` | guide to `engineering:install`; no prompt |
| Mode 2: entry not-found | keychain `not-found` | proceed to recovery-blob path |
| Keychain locked/denied | keychain `error` | "unlock Keychain and retry"; no change |
| No recovery blob | `readRecoveryBlob()` null | honest dead-end message |
| Blob incomplete/corrupt | missing/≠6 rows or bad hex | distinct "recovery blob corrupt" message |
| Unknown `recovery_kdf` | value not in known set | "recovery created by a newer version"; no guess |
| Wrong passphrase | GCM throws / verify fails | "Passphrase did not match"; retry, zero state change |
| Keychain `set` fails in reconnect | `set` throws | session usable; warn "couldn't persist (locked?) — retry" |

## Install & doctor wiring

### `install.sh` keyring smoke-test

After copying `keyring.<tag>.node`: point `NAPI_RS_NATIVE_LIBRARY_PATH` at it,
`node -e` load it, and construct `Entry("pi-engineering","__install_probe__").getPassword()`.
On success echo a verified-native line with Node version + ABI. On failure emit a
**WARNING** (not `exit 1`) with the rebuild guidance. Warning rather than hard
fail because the core workflows run without the keyring — only `/secret-*`
degrades (the existing `else`-branch comment already anticipates this).

### `doctor.ts` read-only vault/recovery checks

| Check | Source | On problem |
|---|---|---|
| sqlite addon loads | smoke require | FAIL → `engineering:install` |
| keyring addon loads | `diagnoseKeyring()` | FAIL (`load-failed`) → ABI rebuild guidance (Mode 1) |
| Keychain master key present | `diagnoseKeyring` ok + keychain get | WARN if not-found + vault exists → "run `/secret-reconnect`" |
| Recovery backup enrolled | `vault.hasRecoveryBackup()` | WARN if absent → "run `/secret-setup-recovery`" |
| Vault openable | open DB read-only | FAIL → surface error |

Each row prints `✓ / ⚠ / ✗` + one-line remediation. `doctor` is strictly
diagnostic — no prompts, no writes; all repair lives in the `/secret-*` commands.

## Testing

Follows existing patterns (temp-dir vaults, in-memory fake `KeyringBackend`,
injected `promptFn`).

**Crypto:** wrap→unwrap round-trip; wrong passphrase throws (GCM); tampered
`wrap`/`tag` throws.

**Vault recovery blob:** round-trip all six fields; `hasRecoveryBackup`
false→true; transactional write leaves no partial blob; corrupt/missing rows →
distinct "corrupt" signal.

**MasterKeyManager precedence (core safety matrix):**
- keychain `value` → used directly, recovery untouched
- not-found + blob + correct passphrase → unlocks; **asserts `backend.set` NOT called** (re-store deferred)
- not-found + blob + wrong passphrase → throws "did not match"; **zero state change**
- not-found + no blob + no salt → fail-closed (existing DESTRUCTIVE message)
- not-found + legacy `saltPath`, no blob → legacy path still works (back-compat)
- empty vault + blob → GCM tag gates (wrong passphrase still rejected)
- `enrollRecovery` requires unlocked key; idempotent overwrite = passphrase change

**Commands:**
- `/secret-setup-recovery`: enrolls; headless path skips cleanly
- `/secret-reconnect`: Mode 1 (mock `load-failed`) → guidance, no prompt/writes;
  Mode 2 + blob → unwrap → **asserts `backend.set` called once**; Mode 2 no blob →
  dead-end, no loop; passphrase mismatch → retry, no change; keychain `set` throws
  → session usable, warns, no crash; already-healthy → "nothing to do"
- `doctor`: correct ✓/⚠/✗ per condition; **asserts no writes, no prompts**

**Nag:** fires once when keychain-unlocked + no blob; silent in passphrase-mode,
empty/no vault, or when a blob exists.

**Install smoke-test:** validated manually in the plan's verification step
(consistent with how the sqlite smoke-test was validated); not bash-unit-tested.
