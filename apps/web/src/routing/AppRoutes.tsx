import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '../layout/AppShell.js';
import { InstrumentPage } from '../features/investor/instrument/InstrumentPage.js';
import { MarketPage } from '../features/investor/market/MarketPage.js';
import { OrdersPage } from '../features/investor/orders/OrdersPage.js';
import { IssueDetailPage } from '../features/issuer/issue/IssueDetailPage.js';
import { MyIssuesPage } from '../features/issuer/issues/MyIssuesPage.js';
import { CreateTokenPage } from '../features/issuer/wizard/CreateTokenPage.js';
import { ElevatorDashboardPage } from '../features/elevator/dashboard/ElevatorDashboardPage.js';
import { ShipmentPage } from '../features/elevator/shipment/ShipmentPage.js';
import { VerificationPage } from '../features/elevator/verification/VerificationPage.js';
import { PlaceholderPage } from '../pages/PlaceholderPage.js';
import { StyleguidePage } from '../pages/StyleguidePage.js';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route element={<Navigate replace to="/market" />} index />
        <Route element={<MarketPage />} path="market" />
        <Route element={<InstrumentPage />} path="market/:instrumentId" />
        <Route element={<OrdersPage />} path="orders" />
        <Route
          element={
            <PlaceholderPage
              subtitle="Токены, денежные счета и история владения."
              title="Мои активы"
            />
          }
          path="assets"
        />
        <Route element={<CreateTokenPage />} path="create-token" />
        <Route element={<MyIssuesPage />} path="my-issues" />
        <Route element={<IssueDetailPage />} path="my-issues/:id" />
        <Route
          element={
            <PlaceholderPage
              subtitle="Стакан, график и управление торговыми заявками."
              title="Торговый терминал"
            />
          }
          path="terminal"
        />
        <Route
          element={
            <PlaceholderPage
              subtitle="Получение физического товара по токенизированному праву."
              title="Погашение"
            />
          }
          path="redemption"
        />
        <Route
          element={
            <PlaceholderPage
              subtitle="Паспорта, подтверждения, договоры и аудиторские материалы."
              title="Документы"
            />
          }
          path="documents"
        />
        <Route
          element={
            <PlaceholderPage
              subtitle="Портфель, заявки и погашения участника."
              title="Кабинет инвестора"
            />
          }
          path="cabinet/investor"
        />
        <Route element={<Navigate replace to="/my-issues" />} path="cabinet/issuer" />
        <Route element={<Navigate replace to="/elevator" />} path="cabinet/elevator" />
        <Route element={<ElevatorDashboardPage />} path="elevator" />
        <Route element={<VerificationPage />} path="elevator/verify/:requestId" />
        <Route element={<ShipmentPage />} path="elevator/shipments/:redemptionId" />
        <Route
          element={
            <PlaceholderPage
              subtitle="Листинг, контроль обеспечения и операционные инциденты."
              title="Кабинет оператора"
            />
          }
          path="cabinet/operator"
        />
        <Route element={<StyleguidePage />} path="styleguide" />
        <Route element={<Navigate replace to="/market" />} path="*" />
      </Route>
    </Routes>
  );
}
