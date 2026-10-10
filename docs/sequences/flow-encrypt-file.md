# Flow: `encryptFileForObject` -- the shared read-encrypt-checksum pipeline

**Derived from:** `src/fs/encrypt-file.ts`

**Used by:** [`flow-apply-local-changes.md`](flow-apply-local-changes.md) (sync's upload),
[`mirror.md`](mirror.md) (`mirror catchup`'s local-recovery re-encrypt, `writeVerifiedMirrorObject`),
[`sanity_check.md`](sanity_check.md)

The one "read a local file, encrypt it exactly as an upload would, learn what came out" assembly --
`fs.createReadStream` → (optionally) `countingReadable` → [`encryptStream`](flow-encrypt-stream.md) →
(optionally) a `UploadChecksumTap` (`src/s3/checksum.ts`) -- shared by the three commands above, which
each used to build this chain separately. Convergent encryption (the object key and every chunk's nonce
derive from the master key and `hash` alone -- see
[`docs/architecture/vault-and-encryption.md`](../architecture/vault-and-encryption.md)) is what makes the
ciphertext checksum this produces comparable against whatever S3 actually stored for the same hash:
identical content always encrypts to identical bytes.

## Sequence

```mermaid
sequenceDiagram
    participant Caller
    participant Enc as encryptFileForObject
    participant FS as fs.createReadStream
    participant Codec as encryptStream
    participant Tap as UploadChecksumTap

    Caller->>Enc: encryptFileForObject(path, size, masterKey, hash, { onBytes?, signal?, hashMismatch, checksum })
    Enc->>FS: createReadStream(path)
    opt onBytes given
        Enc->>Enc: wrap in countingReadable(source, onBytes)
    end

    alt hashMismatch === "abort"
        Enc->>Codec: encryptStream(counted, size, masterKey, hash, { expectedHash: hash, signal })
    else hashMismatch === "report"
        Enc->>Codec: encryptStream(counted, size, masterKey, hash, { onPlaintextHash: <store it>, signal })
    end

    opt checksum
        Enc->>Tap: new UploadChecksumTap(); ciphertext = tap.tap(ciphertext)
    end

    Enc->>Enc: settled = new Promise -- resolves on ciphertext 'end', rejects on ciphertext 'error'
    Enc-->>Caller: return { ciphertext, result: settled.then(...) }

    Caller->>Codec: drains `ciphertext` (uploads it, writes it to the mirror, or discards it)
    alt stream ends normally
        Codec-->>Enc: 'end'
        Enc->>Enc: plaintextHash = (hashMismatch === "abort" ? hash : the reported digest)
        opt checksum
            Enc->>Tap: await tap.checksum()
        end
        Enc-->>Caller: result resolves { plaintextHash, ciphertextChecksum }
    else stream errors (hash mismatch in "abort" mode, a read failure, a size change)
        Codec-->>Enc: 'error'
        Enc-->>Caller: result rejects with the same error
    end
```

## Notes

- **In `"abort"` mode, `result`'s `plaintextHash` is never actually read off the hasher** — reaching
  `'end'` at all already proves the content hashed to `hash`, since `expectedHash`'s own assertion inside
  `encryptStream` is what would have rejected `settled` instead, before `ciphertext` ever got there. So
  `plaintextHash` is just `hash` echoed back.
- **In `"report"` mode, `onPlaintextHash` fires before `'end'`** (it fires once the last plaintext chunk
  is consumed; the final ciphertext chunk, and then stream completion, follow after) -- by the time
  `settled` resolves, the reported digest is already in hand.
- **`checksum: false` is for sync's own upload** (`runUploadJob` in `src/sync/apply-local-changes.ts`):
  it already gets a S3-corroborated CRC64NVME back from `uploadObjectStream`'s own PUT/multipart-complete
  response (see [`flow-put-object-stream.md`](flow-put-object-stream.md)), so a second pure-JS CRC pass
  over every byte here would be pointless. `writeVerifiedMirrorObject` and `sanity_check` both pass
  `checksum: true` -- neither has another source for that value.
- **`result` is always given a no-op `.catch()`**, so a caller that only drains `ciphertext` itself
  (`sanity_check`, discarding the bytes) never turns an unobserved rejection into an unhandled one; that
  caller's own consumer of `ciphertext` already sees the identical failure through its own `'error'`
  listener (or the pool wrapping it, for `sanity_check` — see [`sanity_check.md`](sanity_check.md)).
- **No internal concurrency** -- one source stream, one encryption pass, at most one checksum tap, fully
  sequential. Whatever pool bounds how many files are read at once (sync's/mirror's stream pool) is the
  caller's responsibility, same as it always was before this was shared.
- **`sanity_check` runs this inside a worker thread, not on the main thread.** `checksumFileTask`
  (`src/concurrency/hash-worker.ts`) calls `encryptFileForObject` exactly as shown above, from inside a
  Piscina worker -- genuine multi-core parallelism across different files, since the CRC64NVME pass here
  is pure-JS and CPU-bound (confirmed: ~240 MiB/s on one core, well below the ~1100+ MiB/s either side of
  it). `src/commands/sanity_check.ts` binds its `readLocal` to `createChecksumRunner(pools.hash,
masterKey)` (`src/concurrency/hash-runner.ts`), which dispatches to `checksumFileTask` by name
  (`pool.run(task, { name: "checksumFileTask" })`) rather than running this function in-process; see
  [`sanity_check.md`](sanity_check.md).
- **Sub-flows:** [`flow-encrypt-stream.md`](flow-encrypt-stream.md).
