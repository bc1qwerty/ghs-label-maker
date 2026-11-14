import React from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sun, Moon } from "lucide-react";

// 쪽마다 따로 받는다 — 한 묶음(412KB)이던 때는 약관·개인정보·인쇄 쪽도 홈의 라벨 도구 코드를
// 통째로 받았다(그 쪽에서 안 쓰는 JS ~230KB, 2026-11-12). 셸(React·라우터·쿼리·UI)만 메인 묶음에.
const Home = React.lazy(() => import("@/pages/home"));
const Terms = React.lazy(() => import("@/pages/terms"));
const Privacy = React.lazy(() => import("@/pages/privacy"));
const PrintLabel = React.lazy(() => import("@/pages/print-label"));
const NotFound = React.lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient();

function Router() {
  return (
    <React.Suspense fallback={null}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/terms" component={Terms} />
        <Route path="/privacy" component={Privacy} />
        {/* /print 는 server/index.js 에서 200+noindex 로 따로 준다(SPA_ROUTES 와 별개) */}
        <Route path="/print" component={PrintLabel} />
        <Route component={NotFound} />
      </Switch>
    </React.Suspense>
  );
}

function App() {
  const [isDark, setIsDark] = React.useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("theme");
      if (saved) return saved === "dark";
    } catch {}
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  React.useEffect(() => {
    const root = document.documentElement;
    // .light 도 붙인다 — index.html 의 상단 띠가 OS 다크 규칙을 이것으로 끈다.
    root.classList.toggle("dark", isDark);
    root.classList.toggle("light", !isDark);
  }, [isDark]);

  const toggleTheme = () => {
    setIsDark((prev) => {
      const next = !prev;
      try { localStorage.setItem("theme", next ? "dark" : "light"); } catch {}
      return next;
    });
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base="">
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>

      <button
        onClick={toggleTheme}
        aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        className="print:hidden fixed bottom-5 right-5 z-50 flex items-center justify-center w-10 h-10 rounded-full border border-border bg-card text-foreground shadow-md hover:bg-accent transition-colors"
      >
        {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>
    </QueryClientProvider>
  );
}

export default App;
