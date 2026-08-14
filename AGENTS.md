# AGENTS.md

These rules apply to every directory and every future agent working in this repository.

## Mandatory domain invariants

- Money and commodity quantities MUST be represented only as bigint integer values in their documented minimal units. Floating-point values and float or double types are prohibited for money and quantities in application code, contracts, persistence, events, and tests.
- Ledger entries MUST be created only through packages/ledger. Direct SQL that inserts, updates, or deletes ledger records is prohibited.
- Every API endpoint MUST first be described in packages/contracts/openapi.yaml and only then implemented.
- Every external system MUST be accessed only through an interface in packages/adapters. Domain code MUST NOT make direct outbound HTTP calls. This includes the electronic grain receipt registry, banks, KYC providers, e-signature providers, and blockchains.
- Events MUST be idempotent and carry eventId plus nonce. Reprocessing the same event MUST produce no additional effect.

## Engineering workflow

- Use Conventional Commits for every commit.
- Keep tests next to the code they verify.
- Add a new dependency only when its necessity and trade-offs are explained in the pull request.
- The main branch is assumed to be protected. Work through reviewed pull requests.
- Before handing work back, every agent MUST run pnpm lint, pnpm typecheck, pnpm test, and pnpm build. Report any command that could not be run and the reason.

## Architectural baseline

- OpenAPI 3.1 and event schemas in packages/contracts are the integration source of truth.
- The core application remains a NestJS modular monolith.
- Matching remains a separate single-threaded, event-sourced sequencer process.
- Reliable event publication uses an outbox and NATS JetStream.
- Do not place business logic in transport controllers, persistence adapters, or external-system adapters.
