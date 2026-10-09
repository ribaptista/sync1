# Flow: `encryptStream`, the `expectedHash` abort seam, and `onPlaintextHash`

**Derived from:** `src/crypto/streaming-codec.ts`, `src/crypto/chunked-codec.ts`, `src/crypto/hash.ts`

**Used by:** [`flow-encrypt-file.md`](flow-encrypt-file.md) (the shared pipeline wrapping this for sync's
upload, `mirror catchup`'s local-recovery path, and `sanity_check`)

Encrypts a plaintext stream chunk-by-chunk under a per-object key derived from the master key and a
`context` (the object's content hash, for content objects — see
[`docs/architecture/vault-and-encryption.md`](../architecture/vault-and-encryption.md)). Either of two
mutually-compatible options observes the plaintext's own BLAKE2b hash, computed as it is read, at the same
point — the instant the last plaintext chunk is consumed (or immediately, for a zero-byte plaintext):

- **`expectedHash`** turns this into the write-time half of the content-addressing guarantee: the stream
  is aborted **between the last read and the last yield** if the hash disagrees with the one it is being
  encrypted under.
- **`onPlaintextHash`** instead just reports whatever digest was actually computed, once, and never
  aborts on a mismatch — for a caller (`sanity_check`, via `encryptFileForObject`) that wants to _learn_
  the real hash of whatever is on disk rather than guard a write. Given together with `expectedHash`, a
  mismatch's `throw` happens first, so `onPlaintextHash` never fires for a file `expectedHash` rejects.

## Sequence

```mermaid
sequenceDiagram
    participant Caller
    participant Enc as encryptStream (async generator)
    participant Reader as StreamByteReader
    participant Hasher as StreamingHasher
    participant Source as source stream (fs.createReadStream)

    Caller->>Enc: encryptStream(source, size, masterKey, context, { expectedHash?, onPlaintextHash?, signal? })
    Enc->>Enc: deriveObjectKey(masterKey, context); encodeHeader(...)

    alt totalChunks === 0 (zero-byte plaintext)
        note over Enc: the header alone is the whole body --<br/>nothing left to withhold once it's yielded
        Enc->>Hasher: digestHex() of nothing (finishHash, finalized exactly once)
        alt expectedHash given and mismatches
            Enc-->>Caller: throw, before the header is ever yielded
        else onPlaintextHash given
            Enc-->>Caller: onPlaintextHash(digest)
        end
    end

    Enc-->>Caller: yield header

    loop i = 0 .. totalChunks-1
        alt signal is aborted (checked once per chunk, not continuously)
            Enc->>Source: destroy() -- releases the open file handle<br/>before anyone can leave it unread
            Enc-->>Caller: throw signal.reason
        end
        Enc->>Reader: readExact(chunkLen)
        Reader->>Source: pull bytes until chunkLen satisfied or source ends
        alt fewer bytes than declared (source shrank)
            Reader-->>Enc: short read
            Enc-->>Caller: throw "source file changed size during read?"
        else exact length obtained
            Reader-->>Enc: chunk
            Enc->>Hasher: update(chunk)
            alt this is the LAST chunk and (expectedHash or onPlaintextHash given)
                Enc->>Hasher: digestHex() (finishHash, finalized exactly once)
                alt expectedHash given and mismatches
                    Enc-->>Caller: throw -- the final ciphertext chunk is<br/>NEVER yielded; the body ends short
                else expectedHash matches, or only onPlaintextHash given
                    opt onPlaintextHash given
                        Enc-->>Caller: onPlaintextHash(digest) -- the ACTUAL hash, which may differ from expectedHash's own context
                    end
                    Enc->>Enc: proceed to encrypt and yield the final chunk
                end
            end
            Enc-->>Caller: yield encryptChunk(chunk, objectKey, i)
        end
    end
```

## Notes

- **Concurrency:** none — one source, one reader, fully sequential; the async generator yields to
  whatever is consuming it (typically `uploadObjectStream`, a mirror write, or both at once via
  `teeStream`) one chunk at a time.
- **On failure:** this is the mechanism, not a side effect, of a stronger guarantee. Throwing _before the
  final yield_ means the consumer (`uploadObjectStream`) receives a body shorter than the declared length
  it expected, and the request is aborted rather than completed — see
  [`flow-put-object-stream.md`](flow-put-object-stream.md) for what that looks like from the S3 side. The
  object is therefore **never created**, not created and then cleaned up, which matters because a
  compensating delete would leave a window in which another machine's `verifyRemote` HEAD check could
  adopt the bad object before the cleanup ran.
- **`signal`** is the job-level coordination from `flow-apply-local-changes.md`: when the sink(s) this
  stream feeds have given up for good (the mirror exhausted its retries, S3 gave up), the read stops too
  rather than continuing to read and encrypt bytes nothing downstream will ever consume.
- **What `expectedHash` closes:** the plaintext hash a content object is stored under is computed once,
  during `update_cache`'s scanning phase, from whatever the file's content was _then_. The bytes actually
  streamed here are read later — potentially hours later, on a large vault's upload phase. A file edited
  in between, with its new content happening to be the same length, would otherwise be silently encrypted
  under the _old_ hash's context and stored at the old hash's key — this check is what catches that
  specific, otherwise-undetectable case (a size change alone is already caught by the exact-length check
  above, with or without `expectedHash`).
- **`onPlaintextHash` finalizes the same hasher `expectedHash` would have** — `digestHex()` can only be
  called once per hasher (libsodium's `generichash_final` destroys its state), so `finishHash` (the
  shared helper both options route through) computes the digest exactly once and hands it to whichever
  of the two callbacks applies, in order: `expectedHash`'s assertion first (so a mismatch throws before
  `onPlaintextHash` ever sees it), then `onPlaintextHash` if the stream is still proceeding.
- **Sub-flows:** none.
