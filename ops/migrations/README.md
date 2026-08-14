# Database migrations

This directory contains versioned, pure-SQL dbmate migrations for PostgreSQL 16.

Run migrations from the repository root with pnpm db:migrate. Schema changes must be made through a new migration; application code and ORMs must not generate or mutate production DDL.
