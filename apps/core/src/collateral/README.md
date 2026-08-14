# Collateral module

Owns verified collateral derived exclusively from `APPLIED` oracle events. The internal applied
event consumer maps `RECEIPT_LOCKED` to reserve and `GOODS_RELEASED` to release; no HTTP controller
can call these mutations.

Every mutation verifies the persisted oracle event, stores a unique provenance movement, and adds
an append-only audit record. The lock order is instrument, asset, then position. Locking the asset
serializes reservations for different instruments and prevents double tokenization. Locking the
instrument serializes collateral changes with mint.

`verifiedAvailable(instrumentId)` is the sum of confirmed reserved quantities for that instrument.
The `available` value on all positions for one asset is synchronized to the asset's remaining
unreserved quantity.
