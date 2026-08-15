# Web application

React 18 and Vite foundation for participant and back-office user interfaces.

## Development

- `pnpm --filter @commodity-chain/web dev` starts Vite.
- `pnpm gen:api` regenerates `src/api/generated/schema.ts` from the root OpenAPI contract.
- `/styleguide` renders the design-system components and their states.

CSS Modules are used to keep styles scoped without adding a runtime styling library. Generated API types are committed so a clean checkout can typecheck without running generation first; CI regenerates them and rejects drift.
