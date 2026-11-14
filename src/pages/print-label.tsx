import { useLayoutEffect, useRef, useState } from "react";
import { GhsLabel } from "@/components/ghs-label";
import type { GhsData } from "@/types";

/* 라벨 하나만 그리는 인쇄용 화면. 데이터는 주소 #뒤에 base64url(UTF-8 JSON)로 받는다.
   서버를 거치지 않으므로 추출·결제와 무관하다(MSDS 목록에서 만든 데이터를 그대로 그릴 때 쓴다). */
const A4_HEIGHT = 1123; // 96dpi 에서 A4 세로(px). 라벨 폭 794px 가 A4 가로다.

function decode(hash: string): GhsData | null {
  try {
    const b64 = hash.replace(/^#/, "").replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    // 모양이 어긋난 데이터를 그대로 그리면 라벨 컴포넌트가 던져 흰 화면이 된다.
    const ok = data && typeof data === "object"
      && Array.isArray(data.pictograms) && data.pictograms.every((p: unknown) => p && typeof p === "object")
      && Array.isArray(data.hazardStatements) && data.hazardStatements.every((s: unknown) => typeof s === "string")
      && Array.isArray(data.precautionaryStatements) && data.precautionaryStatements.every((s: unknown) => typeof s === "string");
    return ok ? data : null;
  } catch {
    return null;
  }
}

export default function PrintLabel() {
  const data = decode(window.location.hash);
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  // 문구가 많아 A4 보다 길면 한 장에 들어가게 줄인다(앱의 PDF 내보내기와 같은 원칙).
  useLayoutEffect(() => {
    const h = ref.current?.scrollHeight ?? 0;
    if (h > A4_HEIGHT) setZoom(A4_HEIGHT / h);
  }, []);
  if (!data) return <p style={{ padding: 24 }}>라벨 데이터가 없습니다.</p>;
  return (
    <>
      <style>{"@page { size: A4; margin: 0 } html, body { background: #fff !important; margin: 0 }"}</style>
      <div ref={ref} style={{ background: "#fff", width: 794, zoom }} data-testid="print-label-ready">
        <GhsLabel data={data} />
      </div>
    </>
  );
}
