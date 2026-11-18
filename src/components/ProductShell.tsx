import type { ReactNode } from "react";
import "./product-shell.css";

type IconName = "plus" | "chat" | "chart" | "lab" | "help";

function ShellIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    chat: (
      <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-5 3V7.5A4.5 4.5 0 0 1 7.5 3h8A4.5 4.5 0 0 1 20 7.5v4ZM7 8h9M7 12h6" />
    ),
    chart: (
      <>
        <path d="M4 4v16h16M8 15v-4M13 15V7M18 15v-6" />
      </>
    ),
    lab: (
      <>
        <path d="M9 3h6M10 3v6l-5.3 9a2 2 0 0 0 1.7 3h11.2a2 2 0 0 0 1.7-3L14 9V3M8 14h8" />
        <path d="M10 17h.01M14 18h.01" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 8.5a2.5 2.5 0 1 1 4.2 1.8c-1 .7-1.7 1.2-1.7 2.7M12 16.5h.01" />
      </>
    ),
  };

  return (
    <svg
      className="product-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function ProductBrand() {
  return (
    <span className="product-brand" aria-label="Klar">
      <svg
        className="product-brand-mark"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="9" fill="currentColor" />
        <path
          d="m8 12 8-4 8 4-8 4-8-4Z"
          stroke="white"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="m8 16 8 4 8-4M8 20l8 4 8-4"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        Klar<span className="product-brand-dot">.</span>
      </span>
    </span>
  );
}

export type ProductShellProps = {
  children: ReactNode;
  stage: "setup" | "chat" | "results";
  title: string;
  subtitle?: string;
  onNew: () => void;
  onChat?: () => void;
  onResults?: () => void;
  hasResults: boolean;
  onHelp: () => void;
  busy?: boolean;
};

export function ProductShell({
  children,
  stage,
  title,
  subtitle,
  onNew,
  onChat,
  onResults,
  hasResults,
  onHelp,
  busy = false,
}: ProductShellProps) {
  return (
    <div className="product-shell">
      <aside className="product-sidebar" aria-label="Рабочее пространство">
        <div className="product-sidebar-top">
          <ProductBrand />
          <span className="product-edition">Пространство решений</span>
        </div>

        <nav className="product-navigation" aria-label="Основная навигация">
          <button
            className="product-new-action"
            type="button"
            onClick={onNew}
            disabled={busy}
            aria-current={stage === "setup" ? "page" : undefined}
          >
            <ShellIcon name="plus" />
            <span>Новая задача</span>
          </button>

          <span className="product-nav-label">Пространство</span>
          <button
            className="product-nav-item"
            type="button"
            onClick={onChat}
            disabled={!onChat}
            aria-current={stage === "chat" ? "page" : undefined}
            title={
              !onChat ? "Начните новую задачу, чтобы открыть диалог" : undefined
            }
          >
            <ShellIcon name="chat" />
            <span>Диалог</span>
            {stage === "chat" && (
              <span className="product-nav-active-dot" aria-hidden="true" />
            )}
          </button>
          <button
            className="product-nav-item"
            type="button"
            onClick={onResults}
            disabled={!hasResults || !onResults}
            aria-current={stage === "results" ? "page" : undefined}
            title={
              !hasResults
                ? "Результаты появятся после сравнения вариантов"
                : undefined
            }
          >
            <ShellIcon name="chart" />
            <span>Результаты</span>
            {stage === "results" && (
              <span className="product-nav-active-dot" aria-hidden="true" />
            )}
          </button>
          <a className="product-nav-item" href="/lab">
            <ShellIcon name="lab" />
            <span>Лаборатория</span>
            <svg
              className="product-external-icon"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              aria-hidden="true"
            >
              <path d="M5 11 11 5M5 5h6v6" />
            </svg>
          </a>
        </nav>

        <div className="product-sidebar-bottom">
          <div className="product-sidebar-note">
            <span className="product-note-symbol" aria-hidden="true">
              ↗
            </span>
            <p>
              Больше ясности.
              <br />
              <strong>Меньше сомнений.</strong>
            </p>
            <span>Данные → сравнение → решение</span>
          </div>
          <button
            className="product-nav-item product-help-action"
            type="button"
            onClick={onHelp}
            aria-label="Как это работает"
          >
            <ShellIcon name="help" />
            <span>Как это работает</span>
          </button>
          <div className="product-sidebar-caption">
            <span>Klar</span>
            <span aria-hidden="true">/</span>
            <span>Поддержка решений</span>
          </div>
        </div>
      </aside>

      <main className="product-main">
        <header className="product-topbar">
          <div className="product-page-heading">
            <div className="product-breadcrumb">
              <span>Рабочее пространство</span>
              <span className="product-breadcrumb-divider" aria-hidden="true">
                /
              </span>
              <span className="product-current-page">{title}</span>
            </div>
            {subtitle && <p className="product-page-subtitle">{subtitle}</p>}
          </div>
          <span
            className={`product-connection-status${busy ? " is-busy" : ""}`}
            role="status"
          >
            <span aria-hidden="true" />
            {busy ? "Обрабатываем запрос" : "Готов к работе"}
          </span>
        </header>
        <div className="product-content">{children}</div>
      </main>
    </div>
  );
}
