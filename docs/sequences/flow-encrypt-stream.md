# Flow: `encryptStream` and the `expectedHash` abort seam

**Derived from:** `src/crypto/streaming-codec.ts`, `src/crypto/chunked-codec.ts`, `src/crypto/hash.ts`

**Used by:** [`flow-apply-local-changes.md`](flow-apply-local-changes.md) (sync's upload, via
[`flow-put-object-stream.md`](flow-put-object-stream.md)), [`mirror.md`](mirror.md) (`mirror catchup`'s
local-recovery path)

Encrypts a plaintext stream chunk-by-chunk under a per-object key derived from the master key and a
`context` (the object's content hash, for content objects — see
[`docs/architecture/vault-and-encryption.md`](../architecture/vault-and-encryption.md)). The optional
`expectedHash` turns this into the write-time half of the content-addressing guarantee: the plaintext is
hashed as it is read, and the stream is aborted **between the last read and the last yield** if it
disagrees with the hash it is being encrypted under.

## Sequence

```mermaid
sequenceDiagram
    participant Caller
    participant Enc as encryptStream (async generator)
    participant Reader as StreamByteReader
    participant Hasher as StreamingHasher
    participant Source as source stream (fs.createReadStream)

    Caller->>Enc: encryptStream(source, size, masterKey, context, { expectedHash? })
    Enc->>Enc: deriveObjectKey(masterKey, context); encodeHeader(...)

    alt totalChunks === 0 (zero-byte plaintext)
        note over Enc: the header alone is the whole body --<br/>nothing left to withhold once it's yielded
        Enc->>Hasher: digestHex() of nothing
        alt expectedHash given and mismatches
            Enc-->>Caller: throw, before the header is ever yielded
        end
    end

    Enc-->>Caller: yield header

    loop i = 0 .. totalChunks-1
        Enc->>Reader: readExact(chunkLen)
        Reader->>Source: pull bytes until chunkLen satisfied or source ends
        alt fewer bytes than declared (source shrank)
            Reader-->>Enc: short read
            Enc-->>Caller: throw "source file changed size during read?"
        else exact length obtained
            Reader-->>Enc: chunk
            Enc->>Hasher: update(chunk)
            alt this is the LAST chunk and expectedHash was given
                Enc->>Hasher: digestHex()
                alt matches expectedHash
                    Enc->>Enc: proceed to encrypt and yield the final chunk
                else mismatches
                    Enc-->>Caller: throw -- the final ciphertext chunk is<br/>NEVER yielded; the body ends short
                end
            end
            Enc-->>Caller: yield encryptChunk(chunk, objectKey, i)
        end
    end
```

## Notes

- **Concurrency:** none — one source, one reader, fully sequential; the async generator yields to
  whatever is consuming it (typically `putObjectStream`'s tap, or a mirror write) one chunk at a time.
- **On failure:** this is the mechanism, not a side effect, of a stronger guarantee. Throwing _before the
  final yield_ means the consumer (`putObjectStream`) receives a body shorter than the `ContentLength` it
  declared, and the SDK aborts the request rather than completing it — see
  [`flow-put-object-stream.md`](flow-put-object-stream.md) for what that looks like from the S3 side. The
  object is therefore **never created**, not created and then cleaned up, which matters because a
  compensating delete would leave a window in which another machine's `verifyRemote` HEAD check could
  adopt the bad object before the cleanup ran.
- **What `expectedHash` closes:** the plaintext hash a content object is stored under is computed once,
  during `update_cache`'s scanning phase, from whatever the file's content was _then_. The bytes actually
  streamed here are read later — potentially hours later, on a large vault's upload phase. A file edited
  in between, with its new content happening to be the same length, would otherwise be silently encrypted
  under the _old_ hash's context and stored at the old hash's key — this check is what catches that
  specific, otherwise-undetectable case (a size change alone is already caught by the exact-length check
  above, with or without `expectedHash`).
- **Sub-flows:** none.
