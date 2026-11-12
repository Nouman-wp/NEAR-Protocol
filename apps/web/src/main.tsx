import { StrictMode, lazy, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./styles/app.css";
import { Header, Footer } from "./components/chrome.tsx";
import Landing from "./pages/Landing.tsx";
import { startLive } from "./lib/api.ts";

const Floor = lazy(() => import("./pages/Floor.tsx"));
const RoundList = lazy(() => import("./pages/Rounds.tsx").then((m) => ({ default: m.RoundList })));
const RoundPage = lazy(() => import("./pages/Rounds.tsx").then((m) => ({ default: m.RoundPage })));
const EpochList = lazy(() => import("./pages/Epochs.tsx").then((m) => ({ default: m.EpochList })));
const EpochPage = lazy(() => import("./pages/Epochs.tsx").then((m) => ({ default: m.EpochPage })));
const AgentList = lazy(() => import("./pages/Agents.tsx").then((m) => ({ default: m.AgentList })));
const AgentPage = lazy(() => import("./pages/Agents.tsx").then((m) => ({ default: m.AgentPage })));
const JobPage = lazy(() => import("./pages/Job.tsx"));
const Verify = lazy(() => import("./pages/Verify.tsx"));
const Disputes = lazy(() => import("./pages/Verify.tsx").then((m) => ({ default: m.Disputes })));
const Developers = lazy(() => import("./pages/Developers.tsx"));

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function App() {
  return (
    <>
      <div className="ambient" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <ScrollToTop />
      <Header />
      <Suspense fallback={<div className="page" aria-busy="true" />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/floor" element={<Floor />} />
          <Route path="/rounds" element={<RoundList />} />
          <Route path="/rounds/:id" element={<RoundPage />} />
          <Route path="/epochs" element={<EpochList />} />
          <Route path="/epochs/:id" element={<EpochPage />} />
          <Route path="/agents" element={<AgentList />} />
          <Route path="/agents/:id" element={<AgentPage />} />
          <Route path="/jobs/:id" element={<JobPage />} />
          <Route path="/disputes" element={<Disputes />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/developers" element={<Developers />} />
          <Route path="/status" element={<Developers />} />
          <Route path="*" element={<Landing />} />
        </Routes>
      </Suspense>
      <Footer />
    </>
  );
}

startLive();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
