import React from "react";
import {
  Upload, FileText, AlertTriangle, Printer,
  RotateCcw, CheckCircle, XCircle, Loader2,
  Download, Files, X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { GhsLabel } from "@/components/ghs-label";
import { TransportLabel, type TransportData } from "@/components/transport-label";
import { PaymentModal } from "@/components/payment-modal";
import { GhsData } from "@/types";

type Mode = "ghs" | "transport";

type BatchResultItem = {
  filename: string;
  status: "success" | "error";
  data?: GhsData;
  error?: string | null;
};

type ProcessingStatus = "idle" | "processing" | "done";

// txid-auth.js global
declare global {
  interface Window {
    txidAuth?: {
      getUser: () => { pubkey: string; displayName?: string } | null;
      onAuthChange: (cb: (user: { pubkey: string } | null) => void) => void;
      openLogin: () => void;
    };
  }
}

export default function Home() {
  const [mode, setMode] = React.useState<Mode>("ghs");
  const [files, setFiles] = React.useState<File[]>([]);
  const [language, setLanguageState] = React.useState<string>(() => {
    try { return localStorage.getItem("ghs-lang") || "en"; } catch { return "en"; }
  });
  const setLanguage = (lang: string) => {
    setLanguageState(lang);
    try { localStorage.setItem("ghs-lang", lang); } catch {}
  };
  const [processingStatus, setProcessingStatus] = React.useState<ProcessingStatus>("idle");
  const [results, setResults] = React.useState<BatchResultItem[]>([]);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = React.useState(false);
  const [userPubkey, setUserPubkey] = React.useState<string | null>(null);
  const [needsPayment, setNeedsPayment] = React.useState(false);
  const [userInfo, setUserInfo] = React.useState<{
    totalUsed: number; credits: number; plan: string;
    planExpiresAt: number; freeRemaining: number;
  } | null>(null);
  const [history, setHistory] = React.useState<Array<{
    id: number; mode: string; filename: string; created_at: number;
  }>>([]);
  const [historyItem, setHistoryItem] = React.useState<{ mode: string; data: any } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const labelContainerRef = React.useRef<HTMLDivElement>(null);

  // Listen for auth state changes from txid-auth.js
  React.useEffect(() => {
    const check = () => {
      const user = window.txidAuth?.getUser?.();
      setUserPubkey(user?.pubkey || null);
    };
    check();
    // Poll until txid-auth.js loads
    const interval = setInterval(check, 1000);
    const timeout = setTimeout(() => clearInterval(interval), 10000);
    // Listen for auth changes
    try { window.txidAuth?.onAuthChange?.((u) => setUserPubkey(u?.pubkey || null)); } catch {}
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, []);

  // Fetch user info when pubkey changes
  const fetchUserInfo = React.useCallback(async () => {
    if (!userPubkey) { setUserInfo(null); setHistory([]); return; }
    try {
      const [userRes, histRes] = await Promise.all([
        fetch(`/api/user/${userPubkey}`),
        fetch(`/api/history/${userPubkey}`),
      ]);
      if (userRes.ok) setUserInfo(await userRes.json());
      if (histRes.ok) setHistory(await histRes.json());
    } catch {}
  }, [userPubkey]);

  React.useEffect(() => { fetchUserInfo(); }, [fetchUserInfo]);

  const loadHistoryItem = async (id: number) => {
    if (!userPubkey) return;
    try {
      const res = await fetch(`/api/history/${userPubkey}/${id}`);
      if (!res.ok) return;
      const item = await res.json();
      setHistoryItem(item);
      setMode(item.mode);
      setResults([{ filename: item.filename, status: "success", data: item.data, error: null }]);
      setProcessingStatus("done");
    } catch {}
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      (f) => f.type === "application/pdf"
    );
    if (droppedFiles.length > 0) {
      setFiles((prev) => {
        const existing = new Set(prev.map((f) => f.name));
        const newOnes = droppedFiles.filter((f) => !existing.has(f.name));
        return [...prev, ...newOnes];
      });
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []).filter(
      (f) => f.type === "application/pdf"
    );
    if (selected.length > 0) {
      setFiles((prev) => {
        const existing = new Set(prev.map((f) => f.name));
        const newOnes = selected.filter((f) => !existing.has(f.name));
        return [...prev, ...newOnes];
      });
    }
    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleGenerate = async () => {
    if (files.length === 0) return;
    if (!userPubkey) {
      setApiError("Please login with Lightning wallet first (top-right button).");
      window.txidAuth?.openLogin?.();
      return;
    }
    setProcessingStatus("processing");
    setApiError(null);
    setResults([]);
    setNeedsPayment(false);

    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }
    formData.append("language", language);

    try {
      const headers: Record<string, string> = {};
      if (userPubkey) headers["X-User-Pubkey"] = userPubkey;

      const endpoint = mode === "transport" ? "/api/transport/extract-batch" : "/api/ghs/extract-batch";
      const response = await fetch(endpoint, {
        method: "POST",
        body: formData,
        headers,
      });

      if (response.status === 402) {
        const err = await response.json().catch(() => ({})) as { needsLogin?: boolean; message?: string };
        if (err.needsLogin && !userPubkey) {
          setApiError("Free trial exhausted. Please login and purchase credits.");
          window.txidAuth?.openLogin?.();
        } else {
          setApiError("Free trial exhausted. Please purchase credits.");
          setNeedsPayment(true);
        }
        setProcessingStatus("idle");
        return;
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Unknown error" }));
        setApiError((err as { error?: string }).error ?? "Server error");
        setProcessingStatus("idle");
        return;
      }

      const data = (await response.json()) as BatchResultItem[];
      setResults(data);
      setProcessingStatus("done");
    } catch (err) {
      setApiError("Network error. Please check your connection and try again.");
      setProcessingStatus("idle");
    }
  };

  const handleReset = () => {
    setFiles([]);
    setResults([]);
    setApiError(null);
    setProcessingStatus("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownloadPdf = async () => {
    const successResults = results.filter((r) => r.status === "success" && r.data);
    if (successResults.length === 0) return;

    setIsGeneratingPdf(true);
    try {
      const { default: jsPDF } = await import("jspdf");
      const { toJpeg } = await import("html-to-image");

      const wrapperDivs = labelContainerRef.current?.querySelectorAll<HTMLElement>("[data-label-index]");
      if (!wrapperDivs || wrapperDivs.length === 0) {
        setIsGeneratingPdf(false);
        return;
      }
      // Capture just the inner label element (not the gray wrapper background)
      const labelDivs = Array.from(wrapperDivs).map(
        (w) => w.querySelector<HTMLElement>('[data-testid="ghs-label-container"]') ?? w
      );

      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 5; // 5mm margin on each side

      for (let i = 0; i < labelDivs.length; i++) {
        const el = labelDivs[i];
        const captureOpts = {
          quality: 0.97,
          backgroundColor: "#ffffff",
          pixelRatio: 2,
          skipFonts: true,
          preferredFontFormat: "woff2" as const,
        };
        // Render twice: first pass warms up, second pass captures cleanly
        await toJpeg(el, captureOpts);
        const imgData = await toJpeg(el, captureOpts);

        // Label is designed at A4 ratio — fill page with minimal margin
        const maxW = pageW - margin * 2;
        const maxH = pageH - margin * 2;

        const rect = el.getBoundingClientRect();
        const imgRatio = rect.width / rect.height;

        let drawW = maxW;
        let drawH = drawW / imgRatio;
        if (drawH > maxH) {
          drawH = maxH;
          drawW = drawH * imgRatio;
        }
        const x = (pageW - drawW) / 2;
        const y = margin;

        if (i > 0) pdf.addPage();
        pdf.addImage(imgData, "JPEG", x, y, drawW, drawH);
      }

      const successFilenames = results
        .filter((r) => r.status === "success" && r.data)
        .map((r) => r.filename.replace(/\.pdf$/i, ""));

      const suffix = mode === "transport" ? "trslabel" : "ghslabel";
      let pdfFilename: string;
      if (successFilenames.length === 1) {
        pdfFilename = `${successFilenames[0]}_${suffix}.pdf`;
      } else {
        const dateStr = new Date().toISOString().slice(0, 10);
        const prefix = mode === "transport" ? "Transport_Labels" : "GHS_Labels";
        pdfFilename = `${prefix}_${successFilenames.length}files_${suffix}_${dateStr}.pdf`;
      }
      pdf.save(pdfFilename);
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const successCount = results.filter((r) => r.status === "success").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col">
      {/* Header is in index.html (static, for txid-auth mount timing) */}

      <main className="flex-1 container mx-auto px-4 py-8">
        {processingStatus !== "done" ? (
          /* Upload Section — 2-column layout */
          <div className="max-w-5xl mx-auto">
            <div className="xl:grid xl:grid-cols-[300px_1fr_260px] lg:grid lg:grid-cols-[280px_1fr] lg:gap-6">

              {/* Left: Info Panel */}
              <aside className="space-y-5 mb-8 lg:mb-0 lg:sticky lg:top-8 lg:self-start print:hidden">
                <div>
                  <h2 className="text-2xl font-bold tracking-tight mb-2">GHS Label Generator</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Upload MSDS (Safety Data Sheet) PDFs and instantly generate
                    GHS-compliant hazard labels powered by AI. Supports batch
                    processing up to 30 files.
                  </p>
                </div>

                {/* Notice */}
                <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-muted-foreground leading-relaxed">
                  <p className="font-semibold text-yellow-600 dark:text-yellow-400 mb-1">Why paid?</p>
                  <p>This tool was originally free, but overwhelming demand made it unsustainable. To keep the service running reliably, we now use a low-cost credit system. Your first 3 extractions are still free.</p>
                </div>

                {/* How it works */}
                <div className="space-y-3">
                  <p className="font-semibold text-sm">How it works</p>
                  <div className="space-y-2">
                    <div className="flex gap-3 items-start">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">1</span>
                      <p className="text-sm text-muted-foreground">Upload one or more MSDS PDF files</p>
                    </div>
                    <div className="flex gap-3 items-start">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">2</span>
                      <p className="text-sm text-muted-foreground">AI extracts hazard data, pictograms, and statements</p>
                    </div>
                    <div className="flex gap-3 items-start">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">3</span>
                      <p className="text-sm text-muted-foreground">Download print-ready GHS labels as PDF</p>
                    </div>
                  </div>
                </div>

                {/* Pricing */}
                <div className="space-y-2">
                  <p className="font-semibold text-sm">Pricing</p>
                  <div className="rounded-lg border bg-card p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between"><span className="text-muted-foreground">Free trial</span><span className="font-semibold text-emerald-600">3 extractions</span></div>
                    <div className="border-t my-1"></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Per use</span><span className="font-medium">100 sats</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Weekly (50)</span><span className="font-medium">3,000 sats</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Monthly (200)</span><span className="font-medium text-primary">9,900 sats</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Annual (2,400)</span><span className="font-medium">79,000 sats</span></div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">Pay with Bitcoin Lightning. Instant activation.</p>
                </div>

                {!userPubkey && (
                  <div className="text-xs text-muted-foreground space-y-1 xl:hidden">
                    <p>Sign in with a Lightning wallet to track usage and buy credits.</p>
                  </div>
                )}
              </aside>

              {/* Center: Upload area */}
              <div className="space-y-6">

            {/* Mode Tabs */}
            <div className="flex rounded-lg border bg-muted/30 p-1">
              <button
                onClick={() => { setMode("ghs"); setResults([]); setProcessingStatus("idle"); setApiError(null); }}
                className={`flex-1 py-2 px-4 rounded-md text-sm font-semibold transition-colors ${mode === "ghs" ? "bg-card shadow-sm text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                GHS Label
              </button>
              <button
                onClick={() => { setMode("transport"); setResults([]); setProcessingStatus("idle"); setApiError(null); }}
                className={`flex-1 py-2 px-4 rounded-md text-sm font-semibold transition-colors ${mode === "transport" ? "bg-card shadow-sm text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                Transport Label
              </button>
            </div>

            <Card className="border-2 shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">
                  {"File Upload"}
                </CardTitle>
                <CardDescription>
                  {"Only PDF files are supported. Up to 30 files."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Drop Zone */}
                <div
                  className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors cursor-pointer ${
                    files.length > 0
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
                  }`}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="upload-zone"
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept=".pdf"
                    multiple
                    onChange={handleFileChange}
                    data-testid="input-file"
                  />
                  <div className="flex flex-col items-center gap-3">
                    <Files className="h-10 w-10 text-muted-foreground" />
                    <div className="space-y-1">
                      <p className="font-medium text-sm">
                        {false
                          ? "클릭하거나 파일을 드래그하여 업로드"
                          : "Click to upload or drag and drop"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {"Multiple PDF files supported"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* File List */}
                {files.length > 0 && (
                  <div className="space-y-2" data-testid="file-list">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-muted-foreground">
                        {files.length}{" file(s) selected"}
                      </p>
                      <button
                        className="text-xs text-destructive hover:underline"
                        onClick={() => setFiles([])}
                        data-testid="button-clear-all"
                      >
                        {"Clear all"}
                      </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-1 rounded-md border bg-muted/30 p-2">
                      {files.map((file, idx) => (
                        <div
                          key={`${file.name}-${idx}`}
                          className="flex items-center justify-between gap-2 text-sm px-2 py-1.5 rounded hover:bg-muted"
                          data-testid={`file-item-${idx}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                            <span className="truncate font-medium">{file.name}</span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-xs text-muted-foreground">
                              {(file.size / 1024 / 1024).toFixed(1)}MB
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); removeFile(idx); }}
                              className="text-muted-foreground hover:text-destructive"
                              data-testid={`button-remove-file-${idx}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Language Selection */}
                <div className="space-y-3">
                  <Label className="text-sm font-medium">
                    Output Language
                  </Label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                    data-testid="language-selector"
                  >
                    <option value="en">English</option>
                    <option value="ko">Korean (한국어)</option>
                    <option value="ja">Japanese (日本語)</option>
                    <option value="zh">Chinese Simplified (简体中文)</option>
                    <option value="de">German (Deutsch)</option>
                    <option value="fr">French (Français)</option>
                    <option value="es">Spanish (Español)</option>
                    <option value="pt">Portuguese (Português)</option>
                    <option value="th">Thai (ภาษาไทย)</option>
                    <option value="vi">Vietnamese (Tiếng Việt)</option>
                  </select>
                </div>

                {/* Generate Button */}
                <Button
                  className="w-full"
                  size="lg"
                  disabled={files.length === 0 || processingStatus === "processing"}
                  onClick={handleGenerate}
                  data-testid="button-generate"
                >
                  {processingStatus === "processing" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {`Analyzing ${files.length} file(s)...`}
                    </>
                  ) : (
                    `Generate ${mode === "transport" ? "Transport" : "GHS"} Labels (${files.length} file${files.length !== 1 ? "s" : ""})`
                  )}
                </Button>

                {apiError && (
                  <div
                    className="p-4 rounded-md bg-destructive/10 text-destructive text-sm font-medium border border-destructive/20"
                    data-testid="error-message"
                  >
                    {apiError}
                    {needsPayment && userPubkey && (
                      <Button
                        size="sm"
                        className="mt-3 w-full"
                        onClick={() => setNeedsPayment(true)}
                      >
                        Purchase Credits
                      </Button>
                    )}
                  </div>
                )}

                {needsPayment && userPubkey && (
                  <PaymentModal
                    pubkey={userPubkey}
                    fileCount={files.length > 0 ? files.length : undefined}
                    onClose={() => setNeedsPayment(false)}
                    onPaid={() => { setNeedsPayment(false); setApiError(null); fetchUserInfo(); }}
                  />
                )}
              </CardContent>
            </Card>

              </div>{/* end center column */}

              {/* Right column: Account & History (xl only, lg shows inline) */}
              <aside className="hidden xl:block space-y-4 lg:sticky lg:top-8 lg:self-start print:hidden">
                {userPubkey && userInfo ? (
                  <div className="rounded-lg border bg-card p-3 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <p className="text-emerald-600 font-semibold">Account</p>
                      <p className="text-muted-foreground font-mono">{userPubkey.slice(0, 8)}...{userPubkey.slice(-4)}</p>
                    </div>
                    <div className="border-t"></div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md bg-muted/50 p-2 text-center">
                        <p className="text-lg font-bold text-primary">{userInfo.credits || userInfo.freeRemaining}</p>
                        <p className="text-[10px] text-muted-foreground">{userInfo.credits > 0 ? "Credits" : "Free left"}</p>
                      </div>
                      <div className="rounded-md bg-muted/50 p-2 text-center">
                        <p className="text-lg font-bold">{userInfo.totalUsed}</p>
                        <p className="text-[10px] text-muted-foreground">Used</p>
                      </div>
                    </div>
                    {userInfo.plan !== "free" && userInfo.planExpiresAt > 0 && (
                      <>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-muted-foreground">Plan</span>
                          <span className="font-medium capitalize">{userInfo.plan}</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-muted-foreground">Expires</span>
                          <span className="font-medium">{new Date(userInfo.planExpiresAt * 1000).toLocaleDateString()}</span>
                        </div>
                      </>
                    )}
                    <Button size="sm" variant="outline" className="w-full text-xs h-7" onClick={() => setNeedsPayment(true)}>
                      Buy More Credits
                    </Button>
                  </div>
                ) : userPubkey ? (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                    <p className="text-emerald-600 font-medium">Logged in</p>
                    <p className="text-muted-foreground font-mono mt-0.5">{userPubkey.slice(0, 10)}...</p>
                  </div>
                ) : (
                  <div className="rounded-lg border bg-card p-4 text-center space-y-3">
                    <div className="text-3xl">⚡</div>
                    <p className="text-sm font-semibold">Lightning Login</p>
                    <p className="text-xs text-muted-foreground">Sign in with your Bitcoin Lightning wallet to track usage and purchase credits.</p>
                    <Button size="sm" className="w-full" onClick={() => window.txidAuth?.openLogin?.()}>
                      Login
                    </Button>
                    <p className="text-[10px] text-muted-foreground">
                      Try <a href="https://phoenix.acinq.co/" target="_blank" rel="noopener" className="underline text-primary">Phoenix</a> or <a href="https://www.walletofsatoshi.com/" target="_blank" rel="noopener" className="underline text-primary">Wallet of Satoshi</a>
                    </p>
                  </div>
                )}

                {userPubkey && history.length > 0 && (
                  <div className="space-y-2">
                    <p className="font-semibold text-sm">Recent Labels</p>
                    <div className="rounded-lg border bg-card max-h-64 overflow-y-auto">
                      {history.slice(0, 20).map((item) => (
                        <button
                          key={item.id}
                          onClick={() => loadHistoryItem(item.id)}
                          className="w-full text-left px-3 py-2 text-xs hover:bg-muted/50 border-b last:border-b-0 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">{item.filename}</span>
                            <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded ${item.mode === "transport" ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"}`}>
                              {item.mode === "transport" ? "TR" : "GHS"}
                            </span>
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {new Date(item.created_at * 1000).toLocaleDateString()}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </aside>

            </div>{/* end 3-col grid */}
          </div>
        ) : (
          /* Results Section */
          <div className="max-w-5xl mx-auto space-y-6">
            {/* Results Header */}
            <div className="flex items-center justify-between print:hidden">
              <div className="space-y-1">
                <h2 className="text-xl font-bold tracking-tight">
                  {"Generated Labels"}
                </h2>
                <div className="flex gap-3 text-sm">
                  <span className="flex items-center gap-1 text-emerald-600 font-medium">
                    <CheckCircle className="h-4 w-4" />
                    {`${successCount} succeeded`}
                  </span>
                  {errorCount > 0 && (
                    <span className="flex items-center gap-1 text-destructive font-medium">
                      <XCircle className="h-4 w-4" />
                      {`${errorCount} failed`}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleReset} data-testid="button-reset">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {"Start Over"}
                </Button>
                <Button variant="outline" onClick={handlePrint} data-testid="button-print">
                  <Printer className="mr-2 h-4 w-4" />
                  {"Print"}
                </Button>
                {successCount > 0 && (
                  <Button
                    onClick={handleDownloadPdf}
                    disabled={isGeneratingPdf}
                    data-testid="button-download-pdf"
                  >
                    {isGeneratingPdf ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {"Generating PDF..."}
                      </>
                    ) : (
                      <>
                        <Download className="mr-2 h-4 w-4" />
                        {`Download PDF (${successCount})`}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {/* Per-file status summary */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 print:hidden" data-testid="results-summary">
              {results.map((result, idx) => (
                <div
                  key={idx}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm ${
                    result.status === "success"
                      ? "bg-emerald-50 border-emerald-200 dark:bg-emerald-950 dark:border-emerald-800"
                      : "bg-destructive/5 border-destructive/20"
                  }`}
                  data-testid={`result-status-${idx}`}
                >
                  {result.status === "success" ? (
                    <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium truncate">{result.filename}</p>
                    {result.status === "success" && result.data && (
                      <p className="text-xs text-muted-foreground truncate">{result.data.productName}</p>
                    )}
                    {result.status === "error" && (
                      <p className="text-xs text-destructive">{result.error}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* GHS Labels */}
            <div ref={labelContainerRef} className="space-y-10">
              {results
                .filter((r) => r.status === "success" && r.data)
                .map((result, idx) => (
                  <div key={idx} className={`space-y-2${idx > 0 ? " print:break-before-page" : ""}`}>
                    <p className="text-xs text-muted-foreground font-mono print:hidden">
                      {result.filename}
                    </p>
                    <div
                      className="flex justify-center bg-muted/30 p-8 rounded-xl border print:p-0 print:border-none print:bg-transparent overflow-x-auto"
                      data-label-index={idx}
                    >
                      {mode === "transport"
                        ? <TransportLabel data={result.data! as unknown as TransportData} />
                        : <GhsLabel data={result.data!} />
                      }
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
