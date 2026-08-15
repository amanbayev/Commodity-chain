import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '../layout/AppShell.js';
import { PlaceholderPage } from '../pages/PlaceholderPage.js';
import { StyleguidePage } from '../pages/StyleguidePage.js';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route element={<Navigate replace to="/market" />} index />
        <Route
          element={
            <PlaceholderPage
              subtitle="Обзор токенизированных товарных инструментов."
              title="Рынок"
            />
          }
          path="market"
        />
        <Route
          element={
            <PlaceholderPage
              subtitle="Токены, денежные счета и история владения."
              title="Мои активы"
            />
          }
          path="assets"
        />
        <Route
          element={
            <PlaceholderPage
              subtitle="Подготовка паспорта и отправка инструмента на листинг."
              title="Создать токен"
            />
          }
          path="create-token"
        />
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
        <Route
          element={
            <PlaceholderPage
              subtitle="Выпуски, обеспечение и первичные размещения."
              title="Кабинет эмитента"
            />
          }
          path="cabinet/issuer"
        />
        <Route
          element={
            <PlaceholderPage
              subtitle="Расписки, резервирование и физическая отгрузка."
              title="Кабинет элеватора"
            />
          }
          path="cabinet/elevator"
        />
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
