import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app/App";
import "./styles.css";
import { installController } from "./state/install";

// Capture once at startup, including events arriving before Settings is opened.
const stopInstallEvents = installController.start(window, window.matchMedia("(display-mode: standalone)"));
if (import.meta.hot) import.meta.hot.dispose(stopInstallEvents);

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1 }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></StrictMode>,
);
