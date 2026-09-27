# `sync1 init_remote` / `sync1 attach_remote`

**Derived from:** `src/commands/init_remote.ts`, `src/commands/attach_remote.ts`

The two ways a local root becomes a vault: `init_remote` creates a brand-new one in S3; `attach_remote`
joins an existing one from a new machine. Both are **exempt from the ordinary lock/root-resolution
preamble** (see [`flow-preamble.md`](flow-preamble.md)) — there is no `.sync1/` yet for that hook to find
— and instead take their own lock directly, after creating `.sync1/` themselves. Neither uses
[`flow-unlock-vault.md`](flow-unlock-vault.md) as such (there's no `remote.json` yet to read the
password-check parameters from), though both still call `getPassword`/derive or check against Argon2id
internally.

## Sequence

```mermaid
sequenceDiagram
    participant User
    participant CLI as init_remote / attach_remote
    participant FS
    participant S3

    User->>CLI: sync1 init_remote --bucket B [--prefix][--root][--endpoint][--region]<br/>(or attach_remote, same flags)
    CLI->>FS: root = resolveBootstrapRoot(opts.root) -- defaults to CWD, not an ancestor search
    CLI->>FS: vault.json already exists at this root?
    alt already initialized/attached
        CLI-->>User: throw -- refuses to clobber
    end
    CLI->>FS: mkdirSync(.sync1/, recursive); acquireLock(root) -- this command's OWN lock,<br/>not the shared preAction hook (there is no vault yet for that hook to find)

    alt init_remote
        CLI->>S3: isPrefixEmpty(bucket, prefix)
        opt not empty
            CLI-->>User: throw -- refuses to init over existing data
        end
        CLI->>CLI: createVaultManifest(password) -- new Argon2id salt, new master key
        CLI->>FS: openStateDb(fresh, empty); VersionsRepository.insert(versionStamp); close (checkpoints WAL)
        CLI->>CLI: encryptBuffer(state.db bytes, masterKey, random context)
        CLI->>S3: putObjectCas(vault.json, {ifNoneMatchAny:true})
        CLI->>S3: putObjectCas(states/<versionStamp>, {ifNoneMatchAny:true})
        CLI->>S3: putObjectCas(/current, versionStamp, {ifNoneMatchAny:true})
        note over CLI: EVERY write here is IfNoneMatch -- the first-write-wins CAS variant,<br/>guarding against two init_remote races on the same empty prefix
        CLI->>FS: write last_synced_version, vault.json, remote.json
    else attach_remote
        CLI->>S3: GET vault.json -- missing -> "no vault found"
        CLI->>CLI: unlockVault(manifest, password) -- fails fast on a wrong password,<br/>before ANY filesystem write
        CLI->>S3: GET /current -- missing -> CorruptionError
        CLI->>S3: GET states/<versionStamp> -- missing -> CorruptionError
        CLI->>CLI: decryptBuffer (CryptoAuthError -> CorruptionError)
        CLI->>FS: writeFileWithRetry(state.db, decrypted); write vault.json, last_synced_version, remote.json
        CLI->>FS: openCacheDb(fresh, migrated, empty).close() -- ready for the first update_cache/sync,<br/>holds no rows yet
        note over CLI: no tree materialization here at all -- that happens the<br/>first time `sync` runs (as stubs), same contract as fetch_remote
    end

    CLI->>FS: lock.release()
    CLI-->>User: version_stamp, bucket, prefix, root
```

## Notes

- **Concurrency:** none — every step here is a single awaited call, strictly sequential. There is no
  pool, and (for `attach_remote`) no tree to walk yet.
- **`vault.json`'s existence, not `.sync1/`'s, is the retry-safety boundary.** It is written only at
  the very end of a successful run, so a prior attempt that failed partway through (bad password, a
  non-empty bucket, a lost CAS race, a missing/corrupt remote vault) never permanently blocks a retry
  against the same root — even though it left a non-empty `.sync1/` behind (at minimum, the lock file
  acquired just after the existence check).
- **`init_remote`'s three uploads all use `ifNoneMatchAny`, not a specific `ifMatch` etag** — this is
  the first-write-wins CAS shape, distinct from every commit path in
  [`flow-cas-commit.md`](flow-cas-commit.md) (which all move an _existing_ pointer). It guards
  specifically against two concurrent `init_remote` invocations racing to create the same new vault.
- **`attach_remote` fails on a wrong password before any filesystem write** — `unlockVault` runs
  immediately after fetching the manifest, ahead of every subsequent GET and every local write, so a
  mistyped password never leaves partial vault state behind to clean up.
- **`attach_remote` never materializes the tree.** Only `.sync1/`'s own files are written
  (`state.db`, `vault.json`, `remote.json`, an empty migrated `cache.db`) — every tracked path becomes a
  stub only the first time `sync` runs afterward, mirroring `fetch_remote`'s own contract.
- **`resolveBootstrapRoot` is deliberately different from the ordinary `resolveRoot`** used by every
  other command: it defaults to the current working directory, never searching upward for an existing
  `.sync1/` — there is nothing to find yet, and searching upward here could attach the wrong directory
  entirely if run from inside an existing vault's subtree.
- **On failure:** `lock.release()` runs in a `finally`, so a thrown error at any point (empty-prefix
  check, password, any GET/PUT) still releases the lock — unlike a `SIGINT`, which bypasses it the same
  way it bypasses the ordinary preamble's release (see [`flow-preamble.md`](flow-preamble.md)).
