import React from "react";

export interface TransportData {
  productName: string;
  unNumber: string;
  properShippingName: string;
  hazardClass: string;
  subsidiaryRisks: string[];
  packingGroup: string | null;
  marinePollutant: boolean;
  transportCategory: string | null;
  specialProvisions: string[];
  tunnelRestrictionCode: string | null;
  emergencyAction: string | null;
  additionalInfo: string | null;
  notRegulated: boolean;
  language: string;
}

const CLASS_SVG_MAP: Record<string, string> = {
  "1": "/transport/class1.svg",
  "2.1": "/transport/class2-1.svg",
  "2.2": "/transport/class2-2.svg",
  "2.3": "/transport/class2-3.svg",
  "3": "/transport/class3.svg",
  "4.1": "/transport/class4.svg",
  "4.2": "/transport/class4-2.svg",
  "4.3": "/transport/class4-3.svg",
  "5.1": "/transport/class5.svg",
  "5.2": "/transport/class5-2.svg",
  "6": "/transport/class6.svg",
  "6.1": "/transport/class6.svg",
  "8": "/transport/class8.svg",
  "9": "/transport/class9.svg",
};

// 그림이 없는 등급(6.2 감염성, 7 방사성, 모르는 값)에 다른 등급의 그림을 붙이지 않는다 — 6.2 에 독성 해골,
// 7 에 기타(9) 그림이 나가던 것. 폭발물만 구분(1.1~1.6)이 같은 그림을 쓴다.
function classToSvg(hazardClass: string): string | null {
  const cls = hazardClass.trim();
  return CLASS_SVG_MAP[cls] ?? (cls.split(".")[0] === "1" ? CLASS_SVG_MAP["1"] : null);
}

function ClassMark({ hazardClass, size }: { hazardClass: string; size: number }) {
  const src = classToSvg(hazardClass);
  if (src) return <img src={src} alt={`Class ${hazardClass}`} style={{ width: size, height: size }} />;
  return (
    <div
      role="img"
      aria-label={`Class ${hazardClass}`}
      style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ width: size * 0.68, height: size * 0.68, transform: "rotate(45deg)", border: "3px solid #000", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ transform: "rotate(-45deg)", fontWeight: 900, fontSize: size * 0.22 }}>{hazardClass}</span>
      </div>
    </div>
  );
}

export function TransportLabel({ data }: { data: TransportData }) {
  if (data.notRegulated) {
    return (
      <div
        className="bg-white flex flex-col font-sans text-black"
        data-testid="transport-label-container"
        style={{ width: 794, border: "6px solid #333", boxSizing: "border-box" }}
      >
        <div style={{ padding: "32px 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: 28, fontWeight: 900, margin: "0 0 16px" }}>{data.productName}</h1>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#16a34a", padding: "16px", border: "3px solid #16a34a", borderRadius: 8, display: "inline-block" }}>
            NOT REGULATED FOR TRANSPORT
          </div>
          <p style={{ fontSize: 14, color: "#666", marginTop: 16 }}>
            This substance is not classified as dangerous goods for transport under UN regulations.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-white flex flex-col font-sans text-black"
      data-testid="transport-label-container"
      style={{ width: 794, border: "8px solid #333", boxSizing: "border-box", padding: 0 }}
    >
      {/* Header: Product Name + UN Number */}
      <div style={{ borderBottom: "4px solid #333", padding: "16px 24px", backgroundColor: "#f8f8f8" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0, textTransform: "uppercase", letterSpacing: "0.03em" }}>
              {data.productName}
            </h1>
            <p style={{ fontSize: 14, fontWeight: 600, color: "#555", margin: "4px 0 0" }}>
              {data.properShippingName}
            </p>
          </div>
          <div style={{ textAlign: "right", minWidth: 160 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              UN Number
            </div>
            <div style={{ fontSize: 36, fontWeight: 900, color: "#cc0000", letterSpacing: "0.05em" }}>
              {data.unNumber}
            </div>
          </div>
        </div>
      </div>

      {/* Body: Pictogram + Details */}
      <div style={{ display: "flex", borderBottom: "4px solid #333" }}>
        {/* Left: Diamond pictogram */}
        <div style={{ width: 240, minWidth: 240, borderRight: "3px solid #333", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 16px", gap: 16 }}>
          {data.hazardClass && (
            <ClassMark hazardClass={data.hazardClass} size={140} />
          )}
          {data.subsidiaryRisks.length > 0 && (
            <div style={{ display: "flex", gap: 8 }}>
              {data.subsidiaryRisks.map((r) => (
                <ClassMark key={r} hazardClass={r} size={60} />
              ))}
            </div>
          )}
          {data.marinePollutant && (
            <div style={{ fontSize: 11, fontWeight: 700, color: "#fff", backgroundColor: "#0369a1", padding: "4px 10px", borderRadius: 4, textTransform: "uppercase" }}>
              Marine Pollutant
            </div>
          )}
        </div>

        {/* Right: Transport details */}
        <div style={{ flex: 1, padding: "20px 24px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <tbody>
              <Row label="Hazard Class" value={data.hazardClass} />
              {data.subsidiaryRisks.length > 0 && (
                <Row label="Subsidiary Risks" value={data.subsidiaryRisks.join(", ")} />
              )}
              <Row label="Packing Group" value={data.packingGroup || "N/A"} />
              {data.transportCategory && <Row label="Transport Category" value={data.transportCategory} />}
              {data.tunnelRestrictionCode && <Row label="Tunnel Code" value={data.tunnelRestrictionCode} />}
              {data.emergencyAction && <Row label="Emergency Action" value={data.emergencyAction} />}
              {data.specialProvisions.length > 0 && (
                <Row label="Special Provisions" value={data.specialProvisions.join(", ")} />
              )}
            </tbody>
          </table>

          {data.additionalInfo && (
            <div style={{ marginTop: 12, padding: "8px 12px", backgroundColor: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 4, fontSize: 12, color: "#92400e" }}>
              {data.additionalInfo}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: "12px 24px", backgroundColor: "#f8f8f8", fontSize: 11, color: "#888", textAlign: "center" }}>
        UN Dangerous Goods Transport Label &mdash; Generated by ghs.txid.uk
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ padding: "6px 8px", fontWeight: 700, color: "#555", borderBottom: "1px solid #eee", width: "40%", verticalAlign: "top" }}>
        {label}
      </td>
      <td style={{ padding: "6px 8px", fontWeight: 600, borderBottom: "1px solid #eee" }}>
        {value}
      </td>
    </tr>
  );
}
