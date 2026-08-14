# Mock source keys

Generate a local Ed25519 key after applying migrations:

```shell
node --experimental-strip-types ops/keys/generate-mock-keys.ts
```

`DATABASE_URL` is required. `MOCK_EZR_SOURCE_ID` and `MOCK_EZR_KEY_ID` are optional. The script inserts the public SPKI PEM into `trusted_sources` and writes the private PKCS#8 PEM under `ops/keys/private/`. Private keys are ignored by Git and an existing key is never overwritten.
