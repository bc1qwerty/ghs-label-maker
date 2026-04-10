import React from "react";
import { X, Loader2, CheckCircle, Zap, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import QRCode from "qrcode";

interface PaymentModalProps {
  pubkey: string;
  fileCount?: number; // if set, show per-file pricing first
  onClose: () => void;
  onPaid: () => void;
}

const PLANS = [
  { key: "weekly",  label: "50 extractions",     sats: 3000,  desc: "7 days" },
  { key: "monthly", label: "200 extractions",    sats: 9900,  desc: "30 days", popular: true },
  { key: "annual",  label: "2,400 extractions",  sats: 79000, desc: "365 days" },
];

type Step = "select" | "invoice" | "paid";

export function PaymentModal({ pubkey, fileCount, onClose, onPaid }: PaymentModalProps) {
  const [step, setStep] = React.useState<Step>("select");
  const [invoice, setInvoice] = React.useState("");
  const [qrDataUrl, setQrDataUrl] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [credits, setCredits] = React.useState(0);
  const [copied, setCopied] = React.useState(false);
  const [invoiceLabel, setInvoiceLabel] = React.useState("");
  const [invoiceAmount, setInvoiceAmount] = React.useState(0);
  const [batchPrice, setBatchPrice] = React.useState<{ perFile: number; total: number; discount: number } | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;

  React.useEffect(() => {
    if (fileCount && fileCount > 0) {
      fetch(`/api/payment/price/${fileCount}`)
        .then(r => r.json())
        .then(data => setBatchPrice(data))
        .catch(() => {});
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fileCount]);

  async function createInvoice(endpoint: string, body: object, label: string) {
    setError(null);
    setChecking(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError((err as { error?: string }).error || "Failed to create invoice");
        setChecking(false);
        return;
      }
      const data = await res.json() as { paymentRequest: string; paymentHash: string; amount: number };
      setInvoice(data.paymentRequest);
      setInvoiceLabel(label);
      setInvoiceAmount(data.amount);

      const qr = await QRCode.toDataURL(data.paymentRequest.toUpperCase(), {
        width: 280, margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      setQrDataUrl(qr);
      setStep("invoice");
      setChecking(false);

      if (isMobile) window.open(`lightning:${data.paymentRequest}`, "_blank");

      pollRef.current = setInterval(async () => {
        try {
          const checkRes = await fetch(`/api/payment/check/${data.paymentHash}`);
          const checkData = await checkRes.json() as { paid: boolean; credits?: number };
          if (checkData.paid) {
            if (pollRef.current) clearInterval(pollRef.current);
            setCredits(checkData.credits || 0);
            setStep("paid");
          }
        } catch {}
      }, 3000);
    } catch {
      setError("Network error");
      setChecking(false);
    }
  }

  const handleBatchPay = () => {
    if (!fileCount) return;
    createInvoice("/api/payment/create-batch", { fileCount, pubkey }, `${fileCount} file${fileCount > 1 ? "s" : ""}`);
  };

  const handlePlanPay = (planKey: string) => {
    const plan = PLANS.find(p => p.key === planKey);
    createInvoice("/api/payment/create", { plan: planKey, pubkey }, plan?.label || planKey);
  };

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(invoice); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card border rounded-xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto p-6 space-y-4 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-muted-foreground hover:text-foreground">
          <X className="h-5 w-5" />
        </button>

        {step === "select" && (
          <>
            <div className="space-y-1">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                Purchase Credits
              </h3>
              <p className="text-sm text-muted-foreground">Pay with Bitcoin Lightning. Instant activation.</p>
            </div>

            {/* Per-file payment (when triggered from generate button) */}
            {fileCount && fileCount > 0 && batchPrice && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Pay for this batch</p>
                <button
                  onClick={handleBatchPay}
                  disabled={checking}
                  className="w-full p-4 rounded-lg border-2 border-primary bg-primary/5 hover:bg-primary/10 transition-colors text-left disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-base">{fileCount} file{fileCount > 1 ? "s" : ""}</p>
                      <p className="text-xs text-muted-foreground">
                        {batchPrice.perFile} sats/file
                        {batchPrice.discount > 0 && (
                          <span className="ml-1 text-emerald-600 font-semibold">({batchPrice.discount}% off)</span>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-lg">{batchPrice.total.toLocaleString()} sats</p>
                    </div>
                  </div>
                </button>

                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t"></div></div>
                  <div className="relative flex justify-center"><span className="bg-card px-3 text-xs text-muted-foreground">or buy a plan for bulk savings</span></div>
                </div>
              </div>
            )}

            {/* Plan-based payment */}
            <div className="space-y-2">
              {!fileCount && <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Choose a plan</p>}
              {PLANS.map((plan) => (
                <button
                  key={plan.key}
                  onClick={() => handlePlanPay(plan.key)}
                  disabled={checking}
                  className={`w-full flex items-center justify-between p-3 rounded-lg border transition-colors text-left disabled:opacity-50 ${
                    plan.popular ? "border-primary/50 hover:bg-primary/5" : "hover:border-primary hover:bg-muted/50"
                  }`}
                >
                  <div>
                    <p className="font-semibold text-sm">
                      {plan.label}
                      {plan.popular && <span className="ml-2 text-xs text-primary font-bold">POPULAR</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">{plan.desc}</p>
                  </div>
                  <p className="font-bold text-sm whitespace-nowrap">{plan.sats.toLocaleString()} sats</p>
                </button>
              ))}
            </div>

            {checking && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Creating invoice...
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}

        {step === "invoice" && (
          <>
            <div className="space-y-1 text-center">
              <h3 className="text-lg font-bold flex items-center justify-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                {invoiceLabel}
              </h3>
              <p className="text-2xl font-bold">{invoiceAmount.toLocaleString()} sats</p>
            </div>

            {!isMobile && qrDataUrl && (
              <div className="flex justify-center">
                <img src={qrDataUrl} alt="Lightning Invoice QR" className="rounded-lg" width={280} height={280} />
              </div>
            )}

            {isMobile && (
              <Button className="w-full" size="lg" onClick={() => window.open(`lightning:${invoice}`, "_blank")}>
                <ExternalLink className="mr-2 h-4 w-4" /> Open in Wallet
              </Button>
            )}

            <div className="bg-muted rounded-lg p-3 space-y-2">
              <div className="break-all text-[10px] font-mono text-muted-foreground max-h-16 overflow-y-auto select-all leading-tight">
                {invoice}
              </div>
              <Button size="sm" variant="outline" className="w-full" onClick={handleCopy}>
                <Copy className="mr-2 h-3 w-3" /> {copied ? "Copied!" : "Copy Invoice"}
              </Button>
            </div>

            {!isMobile && (
              <Button variant="outline" className="w-full" onClick={() => window.open(`lightning:${invoice}`, "_blank")}>
                <ExternalLink className="mr-2 h-4 w-4" /> Open in Wallet App
              </Button>
            )}

            {isMobile && qrDataUrl && (
              <details className="text-center">
                <summary className="text-xs text-muted-foreground cursor-pointer">Show QR Code</summary>
                <div className="flex justify-center mt-2">
                  <img src={qrDataUrl} alt="QR" className="rounded-lg" width={240} height={240} />
                </div>
              </details>
            )}

            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Waiting for payment...
            </div>

            <button onClick={() => { if (pollRef.current) clearInterval(pollRef.current); setStep("select"); }} className="text-xs text-muted-foreground hover:underline w-full text-center">
              ← Back
            </button>
          </>
        )}

        {step === "paid" && (
          <div className="text-center space-y-4 py-4">
            <CheckCircle className="h-14 w-14 text-emerald-500 mx-auto" />
            <h3 className="text-xl font-bold">Payment Confirmed!</h3>
            <p className="text-muted-foreground">
              You now have <strong className="text-foreground">{credits}</strong> credits available.
            </p>
            <Button onClick={() => { onPaid(); onClose(); }} className="w-full" size="lg">
              Continue Generating Labels
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
