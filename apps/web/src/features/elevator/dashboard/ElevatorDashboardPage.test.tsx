// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ElevatorDashboard } from '../api/elevatorApi.js';
import { ElevatorDashboardView } from './ElevatorDashboardPage.js';

const envelope = {
  eventId: '41db1020-ae4c-4ce0-8936-c48f33a06a77',
  schemaVersion: '1',
  instrumentId: '048c13bb-7af1-44e4-9219-22b2cb58c25d',
  assetId: 'ezr-1',
  eventType: 'RECEIPT_LOCKED' as const,
  quantity: '5000',
  unit: 'MT',
  observedAt: '2026-08-15T10:00:00Z',
  effectiveAt: '2026-08-15T10:00:00Z',
  sourceId: 'elevator-1',
  evidenceHash: `sha256:${'a'.repeat(64)}`,
  nonce: 1,
  signature: { algorithm: 'Ed25519' as const, keyId: 'key-1', value: 'a'.repeat(86) },
};
const dashboard: ElevatorDashboard = {
  elevatorId: 'elevator-1',
  onReview: 1,
  reservedQuantity: '5000',
  awaitingShipment: 0,
  activeReceipts: 2,
  verificationRequests: [
    {
      requestId: '41db1020-ae4c-4ce0-8936-c48f33a06a77',
      applicant: 'Grain Capital',
      instrumentId: envelope.instrumentId,
      commodity: 'Пшеница 3 класса',
      quantity: '5000',
      unit: 'MT',
      status: 'REQUIRES_REVIEW',
      receiptStatus: 'AVAILABLE',
      updatedAt: '2026-08-15T10:00:00Z',
    },
  ],
  shipments: [],
  recentEvents: [
    {
      envelope,
      status: 'QUARANTINED',
      failureCode: 'ORACLE_NONCE_GAP',
      receivedAt: '2026-08-15T10:00:00Z',
    },
  ],
};

afterEach(cleanup);
describe('ElevatorDashboardView', () => {
  it('renders real counters, requests and quarantined oracle status', () => {
    render(
      <MemoryRouter>
        <ElevatorDashboardView dashboard={dashboard} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Пшеница 3 класса')).toBeInTheDocument();
    expect(screen.getByText('5 000 т')).toBeInTheDocument();
    expect(screen.getByLabelText('Статус события QUARANTINED')).toHaveTextContent(
      'ORACLE_NONCE_GAP',
    );
  });
});
