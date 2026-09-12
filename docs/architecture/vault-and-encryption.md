# Vault manifest and encryption design

## Why a separate, unencrypted `vault.json`

Deriving the master key from a password requires the KDF salt and cost parameters — but those can't
live _inside_ the encrypted state.db, because you'd need the key to read them, which is what you're
trying to derive in the first place. So `vault.json` is a small plaintext (not secret — the salt
doesn't need to be) object written once by `init_remote`, at a fixed path (`vault.json`, alongside
`states/` and `current` under the vault's prefix), fetched before any password-derived decryption
happens.

It holds:

```json
{
  "version": 1,
  "kdf": "argon2id",
  "kdf_params": { "salt": "<hex>", "opslimit": N, "memlimit": N },
  "verifier": "<hex>",
  "created_at": "<iso8601>"
}
```

`verifier` is the chunked-codec encryption (see below) of a fixed known plaintext
(`sync1-vault-verifier-v1`) under the candidate master key. Checking a password is then: derive the
key, decrypt the verifier, confirm the plaintext matches. A wrong password fails immediately and
clearly (`InvalidPasswordError`), instead of silently producing garbage that only fails much later
when trying to read real content.

## KDF: Argon2id

`crypto_pwhash` (libsodium, via `sodium-native`) with the `ARGON2ID13` algorithm, at **MODERATE** cost
(~250-450ms, 256MiB) rather than INTERACTIVE. The KDF runs at most a handful of times per CLI
invocation (the derived key is reused for the process's lifetime), not in a hot loop, so it's worth
paying for meaningfully better resistance against offline cracking of what may be years of
irreplaceable backed-up photos and videos. SENSITIVE (1GiB, ~1.5-2s) was considered but felt like
needless friction on every invocation for a personal backup tool's threat model.

## Chunked AEAD codec: convergent objects, non-convergent snapshots, and random access

Both content objects (in `objects/<hash[0:2]>/<hash[2:4]>/<hash>` — sharded purely for browsability, see
[dedup-and-object-storage.md](dedup-and-object-storage.md)) and state.db snapshots (in
`states/<version_stamp>`) are
encrypted with the same wire format — chunked `crypto_aead_xchacha20poly1305_ietf`:

```
[4B magic "SY1C"][1B format version][1B context length N][N bytes context]
[4B chunk size][8B total plaintext size]
[chunk_0 ciphertext+16B tag][chunk_1 ciphertext+16B tag]...
```

Each chunk is encrypted **independently** — deliberately not libsodium's `crypto_secretstream`, which
ratchets state from one chunk to the next and would make it impossible to decrypt chunk N without
having processed 0..N-1 first. That statefulness is exactly what a future random-access
streaming-from-S3 utility (e.g. seeking into a backed-up video without downloading the whole file)
cannot tolerate: it needs to compute chunk N's exact ciphertext byte range from the fixed-size header
alone, issue one S3 Range GET, and decrypt that chunk standalone.

Key derivation, per object:

1. `object_key = crypto_generichash(key = master_key, message = context)` — keyed BLAKE2b, mixing the
   master key with a `context` buffer.
2. Per chunk: `(aead_key ‖ nonce) = crypto_kdf_derive_from_key(object_key, subkey_id = chunk_index, context = "sy1obj01", 56 bytes)`,
   split into a 32-byte AEAD key and a 24-byte nonce.

`context` is the one place convergent vs. non-convergent behavior is decided:

- **Content objects**: `context` = the plaintext's own content hash. Identical content always produces
  byte-identical ciphertext (convergent encryption) — which is what makes storage-level dedup work
  without ever comparing plaintext across machines: if an object with that hash already exists, skip
  the upload entirely.
- **state.db snapshots**: `context` = a random salt generated fresh per upload. There's only ever one
  state.db per vault, so there's no dedup benefit to convergence here, and convergent encryption
  elsewhere is a known (if minor, for a single-owner personal vault) privacy tradeoff: it lets anyone
  with read access to the bucket tell which stored objects are byte-identical. Random context avoids
  that entirely for the one place it costs nothing to avoid.

Since `context` travels in the header itself, decryption never needs it supplied separately —
`decryptBuffer(encoded, masterKey)` is fully self-contained.

## CAS mechanism

`/current` is a tiny plaintext object holding just the latest version stamp. Every commit (`init_remote`'s
first write, and later `sync`) writes it with a conditional `PutObject`:

- `IfNoneMatch: "*"` for the very first write to a key (vault creation) — fails if the key already
  exists, preventing a race between two concurrent `init_remote` calls.
- `IfMatch: <etag>` for subsequent updates (`sync`) — fails if another machine already advanced
  `/current` since this machine last read it, which is exactly the signal that a fetch+retry is needed.

Confirmed (Task 0 spike) against `localstack/localstack:4.0` specifically: `latest` requires a Pro
license and refuses to start at all without one, and `3.8` accepts `IfNoneMatch` but silently ignores
`IfMatch` (no rejection on a stale etag) — so `4.0` is pinned in the e2e test harness as the minimum
version that actually enforces both conditions.
