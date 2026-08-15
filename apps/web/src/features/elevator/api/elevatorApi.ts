import type { ApiClient } from '../../../api/client.js';
import type { components } from '../../../api/generated/schema.js';

export type ElevatorDashboard = components['schemas']['ElevatorDashboard'];
export type VerificationRequestDetail = components['schemas']['ElevatorVerificationRequestDetail'];
export type ShipmentDetail = components['schemas']['ElevatorShipmentDetail'];
export type OracleActionResult = components['schemas']['ElevatorOracleActionResult'];

const headers = (actorId: string) => ({ 'X-Actor-Id': actorId });

export async function fetchElevatorDashboard(client: ApiClient, elevatorId: string) {
  return (
    await client.request<ElevatorDashboard, '/elevators/{elevatorId}/dashboard', 'get'>({
      headers: headers(elevatorId),
      method: 'GET',
      path: '/elevators/{elevatorId}/dashboard',
      pathParameters: { elevatorId },
    })
  ).data;
}

export async function fetchVerification(client: ApiClient, elevatorId: string, requestId: string) {
  return (
    await client.request<
      VerificationRequestDetail,
      '/elevators/{elevatorId}/verification-requests/{requestId}',
      'get'
    >({
      headers: headers(elevatorId),
      method: 'GET',
      path: '/elevators/{elevatorId}/verification-requests/{requestId}',
      pathParameters: { elevatorId, requestId },
    })
  ).data;
}

export async function reserveVerification(
  client: ApiClient,
  elevatorId: string,
  requestId: string,
) {
  return (
    await client.request<
      OracleActionResult,
      '/elevators/{elevatorId}/verification-requests/{requestId}/reserve',
      'post'
    >({
      headers: headers(elevatorId),
      idempotencyKey: crypto.randomUUID(),
      method: 'POST',
      path: '/elevators/{elevatorId}/verification-requests/{requestId}/reserve',
      pathParameters: { elevatorId, requestId },
    })
  ).data;
}

export async function fetchShipment(client: ApiClient, elevatorId: string, redemptionId: string) {
  return (
    await client.request<ShipmentDetail, '/elevators/{elevatorId}/shipments/{redemptionId}', 'get'>(
      {
        headers: headers(elevatorId),
        method: 'GET',
        path: '/elevators/{elevatorId}/shipments/{redemptionId}',
        pathParameters: { elevatorId, redemptionId },
      },
    )
  ).data;
}

export async function confirmShipment(client: ApiClient, elevatorId: string, redemptionId: string) {
  return (
    await client.request<
      OracleActionResult,
      '/elevators/{elevatorId}/shipments/{redemptionId}/confirm',
      'post'
    >({
      headers: headers(elevatorId),
      idempotencyKey: crypto.randomUUID(),
      method: 'POST',
      path: '/elevators/{elevatorId}/shipments/{redemptionId}/confirm',
      pathParameters: { elevatorId, redemptionId },
    })
  ).data;
}
