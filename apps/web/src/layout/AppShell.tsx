import { useState } from 'react';
import { Outlet } from 'react-router-dom';

import { Sidebar } from './Sidebar.js';
import { Topbar } from './Topbar.js';
import styles from './AppShell.module.css';

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className={styles.shell}>
      <Sidebar
        onNavigate={() => {
          setSidebarOpen(false);
        }}
        open={sidebarOpen}
      />
      {sidebarOpen ? (
        <button
          aria-label="Закрыть меню"
          className={styles.overlay}
          onClick={() => {
            setSidebarOpen(false);
          }}
          type="button"
        />
      ) : null}
      <div className={styles.workspace}>
        <Topbar
          onMenu={() => {
            setSidebarOpen((value) => !value);
          }}
        />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
