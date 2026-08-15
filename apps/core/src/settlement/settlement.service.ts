import { deterministicUuid } from '@commodity-chain/matching-core';
import { PostgresLedger, type LedgerAccountId, type LedgerLegInput } from '@commodity-chain/ledger';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { SettlementError } from './settlement.errors.js';
import { assertSettlementTransition } from './settlement-state-machine.js';
import type {
  FinalityStatus,
  SettlementCreatedDomainEvent,
  SettlementFailureHooks,
  SettlementProcessingResult,
} from './settlement.types.js';

interface SettlementRow extends QueryResultRow {
  trade_id: string;
  cash_currency: string;
  cash_amount: string;
  cash_payer_party_id: string;
  cash_payee_party_id: string;
  token_instrument_id: string;
  token_quantity: string;
  token_from_party_id: string;
  token_to_party_id: string;
  finality_status: FinalityStatus;
  source_event_id: string | null;
  source_event_nonce: string | null;
  ledger_posting_id: string | null;
  buyer_fee_amount: string;
  seller_fee_amount: string;
  rounding_residual: string;
  failure_code: string | null;
}

interface SnapshotRow extends QueryResultRow {
  cash_source_account_id: string;
  token_source_account_id: string;
  seller_cash_available_account_id: string;
  buyer_token_available_account_id: string;
  fee_account_id: string;
  residual_account_id: string;
}

interface AccountRow extends QueryResultRow {
  id: string;
  balance: string;
}

const SETTLEMENT_COLUMNS = `
  trade_id::text, cash_currency, cash_amount::text,
  cash_payer_party_id::text, cash_payee_party_id::text,
  token_instrument_id::text, token_quantity::text,
  token_from_party_id::text, token_to_party_id::text,
  finality_status::text, source_event_id::text, source_event_nonce::text,
  ledger_posting_id::text, buyer_fee_amount::text, seller_fee_amount::text,
  rounding_residual::text, failure_code
`;

export class SettlementService {
  public constructor(
    private readonly pool: Pool,
    private readonly ledger: PostgresLedger,
    private readonly hooks: SettlementFailureHooks = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async handleCreatedEvent(
    event: SettlementCreatedDomainEvent,
  ): Promise<SettlementProcessingResult> {
    validateEvent(event);
    try {
      const funded = await this.fund(event);
      if (
        funded.status === 'LEGALLY_FINAL' ||
        funded.status === 'RECONCILED' ||
        funded.status === 'PENDING_RECONCILIATION' ||
        funded.status === 'MANUAL_REPAIR' ||
        funded.status === 'FAILED_BEFORE_FINALITY'
      ) {
        return { ...funded, replayed: true };
      }
      return await this.executeDvp(event);
    } catch (error: unknown) {
      if (
        error instanceof SettlementError &&
        (error.code === 'SETTLEMENT_NOT_FOUND' || error.code === 'SETTLEMENT_EVENT_MISMATCH')
      ) {
        throw error;
      }
      return this.markFailed(event, error);
    }
  }

  private async fund(event: SettlementCreatedDomainEvent): Promise<SettlementProcessingResult> {
    return this.withTransaction(async (client) => {
      const settlement = await this.lockSettlement(client, event.tradeId);
      this.assertEventMatches(settlement, event);
      if (settlement.finality_status !== 'CREATED') return toResult(settlement, true);

      if (settlement.source_event_id === null) {
        await client.query(
          `UPDATE settlements SET source_event_id = $2, source_event_nonce = $3 WHERE trade_id = $1`,
          [event.tradeId, event.eventId, event.nonce],
        );
      }

      const snapshot = await this.captureAccounts(client, settlement);
      const cashRequired = BigInt(settlement.cash_amount) + BigInt(settlement.buyer_fee_amount);
      const tokenRequired = BigInt(settlement.token_quantity);
      if (BigInt(settlement.cash_amount) < BigInt(settlement.seller_fee_amount)) {
        throw new SettlementError(
          'SETTLEMENT_NOT_FUNDED',
          `Settlement ${event.tradeId} seller fee exceeds gross cash`,
        );
      }
      const balances = await client.query<AccountRow>(
        `SELECT id::text, balance::text FROM ledger_accounts
         WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[snapshot.cash_source_account_id, snapshot.token_source_account_id]],
      );
      const byId = new Map(balances.rows.map((row) => [row.id, BigInt(row.balance)] as const));
      if ((byId.get(snapshot.cash_source_account_id) ?? -1n) < cashRequired) {
        throw new SettlementError(
          'SETTLEMENT_NOT_FUNDED',
          `Settlement ${event.tradeId} cash commitment is not funded`,
        );
      }
      if ((byId.get(snapshot.token_source_account_id) ?? -1n) < tokenRequired) {
        throw new SettlementError(
          'SETTLEMENT_NOT_FUNDED',
          `Settlement ${event.tradeId} token commitment is not funded`,
        );
      }

      await this.transition(
        client,
        settlement,
        'FUNDED',
        event,
        'settlement:funding-check',
        'Both clearing commitments are funded',
        1n,
      );
      return { settlementId: event.tradeId, status: 'FUNDED', replayed: false };
    });
  }

  private async executeDvp(
    event: SettlementCreatedDomainEvent,
  ): Promise<SettlementProcessingResult> {
    return this.withTransaction(async (client) => {
      let settlement = await this.lockSettlement(client, event.tradeId);
      this.assertEventMatches(settlement, event);
      if (
        isPostFinal(settlement.finality_status) ||
        settlement.finality_status === 'LEGALLY_FINAL'
      ) {
        return toResult(settlement, true);
      }
      if (settlement.finality_status !== 'FUNDED') {
        throw new SettlementError(
          'INVALID_SETTLEMENT_TRANSITION',
          `Settlement ${event.tradeId} must be FUNDED before DvP`,
        );
      }

      await this.transition(
        client,
        settlement,
        'SUBMITTED',
        event,
        'settlement:dvp',
        'Gross DvP submitted to the internal ledger',
        2n,
      );
      settlement = { ...settlement, finality_status: 'SUBMITTED' };
      const snapshot = await this.loadSnapshot(client, event.tradeId);
      const cashAmount = BigInt(settlement.cash_amount);
      const buyerFee = BigInt(settlement.buyer_fee_amount);
      const sellerFee = BigInt(settlement.seller_fee_amount);
      const residual = BigInt(settlement.rounding_residual);
      const exchangeFee = buyerFee + sellerFee - residual;
      const sellerNet = cashAmount - sellerFee;
      const cashSource = cashAmount + buyerFee;
      if (exchangeFee < 0n || sellerNet < 0n) {
        throw new Error(`Settlement ${event.tradeId} fee allocation is inconsistent`);
      }

      const legs: LedgerLegInput[] = [
        leg(snapshot.cash_source_account_id, 'CREDIT', cashSource),
        leg(snapshot.seller_cash_available_account_id, 'DEBIT', sellerNet),
      ];
      if (exchangeFee > 0n) legs.push(leg(snapshot.fee_account_id, 'DEBIT', exchangeFee));
      if (residual > 0n) legs.push(leg(snapshot.residual_account_id, 'DEBIT', residual));
      legs.push(
        leg(snapshot.token_source_account_id, 'CREDIT', BigInt(settlement.token_quantity)),
        leg(snapshot.buyer_token_available_account_id, 'DEBIT', BigInt(settlement.token_quantity)),
      );
      const posting = await this.ledger.withinTransaction(client).post({
        idempotencyKey: `settlement:${event.tradeId}:dvp`,
        correlationId: event.correlationId,
        legs: asLegTuple(legs),
        metadata: {
          operation: 'SETTLEMENT_GROSS_DVP',
          settlementId: event.tradeId,
          tradeId: event.tradeId,
        },
      });
      await this.hooks.afterLedgerPost?.();
      await client.query('UPDATE settlements SET ledger_posting_id = $2 WHERE trade_id = $1', [
        event.tradeId,
        posting.id,
      ]);

      await this.transition(
        client,
        settlement,
        'TECHNICALLY_CONFIRMED',
        event,
        'settlement:ledger',
        'All cash and token legs were posted atomically',
        3n,
      );
      settlement = { ...settlement, finality_status: 'TECHNICALLY_CONFIRMED' };
      await this.transition(
        client,
        settlement,
        'LEGALLY_FINAL',
        event,
        'settlement:ledger',
        'Internal-ledger commit is the legal finality point',
        4n,
      );
      return {
        settlementId: event.tradeId,
        status: 'LEGALLY_FINAL',
        ledgerPostingId: posting.id,
        replayed: false,
      };
    });
  }

  private async markFailed(
    event: SettlementCreatedDomainEvent,
    error: unknown,
  ): Promise<SettlementProcessingResult> {
    return this.withTransaction(async (client) => {
      const settlement = await this.lockSettlement(client, event.tradeId);
      if (
        settlement.finality_status !== 'CREATED' &&
        settlement.finality_status !== 'FUNDED' &&
        settlement.finality_status !== 'SUBMITTED'
      ) {
        return toResult(settlement, true);
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.transition(
        client,
        settlement,
        'FAILED_BEFORE_FINALITY',
        event,
        'settlement:processor',
        'DvP failed before legal finality',
        5n,
      );
      await client.query(
        `UPDATE settlements
         SET failure_code = 'DVP_FAILED', failure_details = $2::jsonb, failed_at = $3
         WHERE trade_id = $1`,
        [event.tradeId, JSON.stringify({ message }), this.now()],
      );
      await this.appendEventLog(client, {
        settlementId: event.tradeId,
        correlationId: event.correlationId,
        actor: 'settlement:processor',
        eventType: 'INCIDENT',
        eventId: deterministicUuid(`settlement:incident:${event.tradeId}`),
        nonce: BigInt(event.nonce) * 10n + 6n,
        occurredAt: this.now(),
        payload: { code: 'DVP_FAILED', message },
      });
      return {
        settlementId: event.tradeId,
        status: 'FAILED_BEFORE_FINALITY',
        failureCode: 'DVP_FAILED',
        replayed: false,
      };
    });
  }

  private async captureAccounts(
    client: PoolClient,
    settlement: SettlementRow,
  ): Promise<SnapshotRow> {
    const existing = await client.query<SnapshotRow>(
      `SELECT cash_source_account_id::text, token_source_account_id::text,
              seller_cash_available_account_id::text, buyer_token_available_account_id::text,
              fee_account_id::text, residual_account_id::text
       FROM settlement_account_snapshots WHERE settlement_id = $1`,
      [settlement.trade_id],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0];

    const clearing = await client.query<
      QueryResultRow & { cash: string; token: string; fee: string; residual: string }
    >(
      `SELECT clearing.cash_reserved_account_id::text AS cash,
              clearing.token_reserved_account_id::text AS token,
              system.fee_account_id::text AS fee,
              system.residual_account_id::text AS residual
       FROM oms_clearing_accounts AS clearing
       JOIN settlement_system_accounts AS system
         ON system.currency = $2
       WHERE clearing.instrument_id = $1`,
      [settlement.token_instrument_id, settlement.cash_currency.trim()],
    );
    const configured = clearing.rows[0];
    if (configured === undefined) {
      throw new SettlementError(
        'SETTLEMENT_ACCOUNTS_NOT_CONFIGURED',
        `Settlement system accounts are not configured for ${settlement.trade_id}`,
      );
    }
    const sellerCash = await this.requireAvailableAccount(client, {
      ownerId: settlement.cash_payee_party_id,
      accountType: 'CASH',
      currency: settlement.cash_currency.trim(),
    });
    const buyerToken = await this.requireAvailableAccount(client, {
      ownerId: settlement.token_to_party_id,
      accountType: 'TOKEN',
      instrumentId: settlement.token_instrument_id,
    });
    await this.validateConfiguredAccounts(client, configured, settlement);
    const inserted = await client.query<SnapshotRow>(
      `INSERT INTO settlement_account_snapshots (
         settlement_id, cash_source_account_id, token_source_account_id,
         seller_cash_available_account_id, buyer_token_available_account_id,
         fee_account_id, residual_account_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING cash_source_account_id::text, token_source_account_id::text,
         seller_cash_available_account_id::text, buyer_token_available_account_id::text,
         fee_account_id::text, residual_account_id::text`,
      [
        settlement.trade_id,
        configured.cash,
        configured.token,
        sellerCash,
        buyerToken,
        configured.fee,
        configured.residual,
      ],
    );
    return required(inserted.rows[0], 'Account snapshot was not returned');
  }

  private async validateConfiguredAccounts(
    client: PoolClient,
    configured: { cash: string; token: string; fee: string; residual: string },
    settlement: SettlementRow,
  ): Promise<void> {
    const result = await client.query<{ id: string } & QueryResultRow>(
      `SELECT account.id::text
       FROM ledger_accounts AS account
       WHERE
         (account.id = $1 AND account.account_type = 'CASH' AND account.purpose = 'RESERVED'
           AND account.currency = $5 AND account.normal_side = 'DEBIT')
         OR (account.id = $2 AND account.account_type = 'TOKEN' AND account.purpose = 'RESERVED'
           AND account.instrument_id = $6 AND account.normal_side = 'DEBIT')
         OR (account.id = $3 AND account.account_type = 'CASH' AND account.purpose = 'FEE'
           AND account.currency = $5 AND account.normal_side = 'DEBIT')
         OR (account.id = $4 AND account.account_type = 'CASH' AND account.purpose = 'RESIDUAL'
           AND account.currency = $5 AND account.normal_side = 'DEBIT')`,
      [
        configured.cash,
        configured.token,
        configured.fee,
        configured.residual,
        settlement.cash_currency.trim(),
        settlement.token_instrument_id,
      ],
    );
    if (result.rows.length !== 4) {
      throw new SettlementError(
        'SETTLEMENT_ACCOUNT_CONFIGURATION_INVALID',
        `Settlement account configuration for ${settlement.trade_id} is invalid`,
      );
    }
  }

  private async requireAvailableAccount(
    client: PoolClient,
    input:
      | { ownerId: string; accountType: 'CASH'; currency: string }
      | { ownerId: string; accountType: 'TOKEN'; instrumentId: string },
  ): Promise<string> {
    const result =
      input.accountType === 'CASH'
        ? await client.query<{ id: string } & QueryResultRow>(
            `SELECT id::text FROM ledger_accounts
             WHERE owner_party_id = $1 AND account_type = 'CASH' AND purpose = 'AVAILABLE'
               AND normal_side = 'DEBIT' AND currency = $2
             ORDER BY id`,
            [input.ownerId, input.currency],
          )
        : await client.query<{ id: string } & QueryResultRow>(
            `SELECT id::text FROM ledger_accounts
             WHERE owner_party_id = $1 AND account_type = 'TOKEN' AND purpose = 'AVAILABLE'
               AND normal_side = 'DEBIT' AND instrument_id = $2
             ORDER BY id`,
            [input.ownerId, input.instrumentId],
          );
    if (result.rows.length !== 1) {
      throw new SettlementError(
        'SETTLEMENT_ACCOUNT_CONFIGURATION_INVALID',
        `Expected exactly one ${input.accountType} AVAILABLE account for ${input.ownerId}`,
      );
    }
    return result.rows[0]!.id;
  }

  private async loadSnapshot(client: PoolClient, settlementId: string): Promise<SnapshotRow> {
    const result = await client.query<SnapshotRow>(
      `SELECT cash_source_account_id::text, token_source_account_id::text,
              seller_cash_available_account_id::text, buyer_token_available_account_id::text,
              fee_account_id::text, residual_account_id::text
       FROM settlement_account_snapshots WHERE settlement_id = $1`,
      [settlementId],
    );
    return required(result.rows[0], `Settlement ${settlementId} has no account snapshot`);
  }

  private async transition(
    client: PoolClient,
    settlement: SettlementRow,
    target: FinalityStatus,
    source: SettlementCreatedDomainEvent,
    actor: string,
    reason: string,
    ordinal: bigint,
  ): Promise<void> {
    assertSettlementTransition(settlement.finality_status, target);
    const occurredAt = this.now();
    const eventId = deterministicUuid(`settlement:transition:${settlement.trade_id}:${target}`);
    const nonce = BigInt(source.nonce) * 10n + ordinal;
    const timestampColumn = transitionTimestampColumn(target);
    await client.query(
      timestampColumn === null
        ? `UPDATE settlements SET finality_status = $2, updated_at = $3 WHERE trade_id = $1`
        : `UPDATE settlements
           SET finality_status = $2, updated_at = $3, ${timestampColumn} = $3
           WHERE trade_id = $1`,
      [settlement.trade_id, target, occurredAt],
    );
    await client.query(
      `INSERT INTO settlement_transitions (
         settlement_id, from_status, to_status, actor, reason,
         event_id, nonce, correlation_id, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        settlement.trade_id,
        settlement.finality_status,
        target,
        actor,
        reason,
        eventId,
        nonce.toString(),
        source.correlationId,
        occurredAt,
      ],
    );
    const payload = {
      eventId,
      nonce: nonce.toString(),
      eventType: 'SETTLEMENT_STATUS_CHANGED',
      schemaVersion: '1',
      occurredAt: occurredAt.toISOString(),
      payload: {
        settlementId: settlement.trade_id,
        fromStatus: settlement.finality_status,
        toStatus: target,
        reason,
      },
    };
    await this.appendEventLog(client, {
      settlementId: settlement.trade_id,
      correlationId: source.correlationId,
      actor,
      eventType: 'SETTLEMENT_STATUS_CHANGED',
      eventId,
      nonce,
      occurredAt,
      payload: payload.payload,
    });
    await client.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb)', [
      'domain.settlement.status-changed.v1',
      JSON.stringify(payload),
    ]);
  }

  private async appendEventLog(
    client: PoolClient,
    input: {
      settlementId: string;
      correlationId: string;
      actor: string;
      eventType: string;
      eventId: string;
      nonce: bigint;
      occurredAt: Date;
      payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO event_log (
         occurred_at, actor, event_type, aggregate_type,
         aggregate_id, correlation_id, payload
       ) VALUES ($1, $2, $3, 'SETTLEMENT', $4, $5, $6::jsonb)`,
      [
        input.occurredAt,
        input.actor,
        input.eventType,
        input.settlementId,
        input.correlationId,
        JSON.stringify({
          eventId: input.eventId,
          nonce: input.nonce.toString(),
          eventType: input.eventType,
          schemaVersion: '1',
          occurredAt: input.occurredAt.toISOString(),
          payload: input.payload,
        }),
      ],
    );
  }

  private async lockSettlement(client: PoolClient, settlementId: string): Promise<SettlementRow> {
    const result = await client.query<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements WHERE trade_id = $1 FOR UPDATE`,
      [settlementId],
    );
    const settlement = result.rows[0];
    if (settlement === undefined) {
      throw new SettlementError('SETTLEMENT_NOT_FOUND', `Settlement ${settlementId} was not found`);
    }
    return settlement;
  }

  private assertEventMatches(settlement: SettlementRow, event: SettlementCreatedDomainEvent): void {
    if (
      (settlement.source_event_id !== null && settlement.source_event_id !== event.eventId) ||
      (settlement.source_event_nonce !== null && settlement.source_event_nonce !== event.nonce)
    ) {
      throw new SettlementError(
        'SETTLEMENT_EVENT_MISMATCH',
        `Settlement ${event.tradeId} belongs to another source event`,
      );
    }
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function transitionTimestampColumn(status: FinalityStatus): string | null {
  switch (status) {
    case 'FUNDED':
      return 'funded_at';
    case 'SUBMITTED':
      return 'submitted_at';
    case 'TECHNICALLY_CONFIRMED':
      return 'technically_confirmed_at';
    case 'LEGALLY_FINAL':
      return 'legally_final_at';
    case 'RECONCILED':
      return 'reconciled_at';
    case 'FAILED_BEFORE_FINALITY':
      return 'failed_at';
    case 'PENDING_RECONCILIATION':
    case 'MANUAL_REPAIR':
    case 'CREATED':
      return null;
  }
}

function validateEvent(event: SettlementCreatedDomainEvent): void {
  if (event.eventType !== 'SETTLEMENT_CREATED' || event.schemaVersion !== '1') {
    throw new SettlementError('SETTLEMENT_EVENT_MISMATCH', 'Unsupported settlement event');
  }
  if (!/^[1-9][0-9]*$/u.test(event.nonce)) {
    throw new SettlementError('SETTLEMENT_EVENT_MISMATCH', 'Settlement event nonce is invalid');
  }
}

function toResult(row: SettlementRow, replayed: boolean): SettlementProcessingResult {
  return {
    settlementId: row.trade_id,
    status: row.finality_status,
    ...(row.ledger_posting_id === null ? {} : { ledgerPostingId: row.ledger_posting_id }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    replayed,
  };
}

function isPostFinal(status: FinalityStatus): boolean {
  return (
    status === 'RECONCILED' || status === 'PENDING_RECONCILIATION' || status === 'MANUAL_REPAIR'
  );
}

function leg(accountId: string, direction: 'DEBIT' | 'CREDIT', amount: bigint): LedgerLegInput {
  return { accountId: accountId as LedgerAccountId, direction, amount };
}

function asLegTuple(
  legs: readonly LedgerLegInput[],
): readonly [LedgerLegInput, LedgerLegInput, ...LedgerLegInput[]] {
  if (legs.length < 2) throw new Error('Settlement posting requires at least two legs');
  return [legs[0]!, legs[1]!, ...legs.slice(2)];
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
