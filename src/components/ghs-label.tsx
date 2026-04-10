import React from "react";
import { GhsData } from "@/types";
import { GhsPictogramIcon } from "./pictograms";

interface GhsLabelProps {
  data: GhsData;
}

export function GhsLabel({ data }: GhsLabelProps) {
  const isKorean = data.language === "ko";
  const isDanger =
    data.signalWord === "Danger" || data.signalWord === "위험";

  return (
    /* Width fixed at A4 (794px); height grows with content */
    <div
      className="bg-white flex flex-col font-sans text-black"
      data-testid="ghs-label-container"
      style={{
        width: 794,
        border: "10px solid #cc0000",
        boxSizing: "border-box",
        padding: 0,
      }}
    >
      {/* ── 1. 상단 헤더: 제품명 ────────────────────────────── */}
      <div
        style={{
          borderBottom: "4px solid #cc0000",
          padding: "14px 24px 10px",
          backgroundColor: "#fff8f8",
        }}
      >
        <h1
          data-testid="label-product-name"
          style={{
            fontSize: 34,
            fontWeight: 900,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            margin: 0,
            lineHeight: 1.15,
            color: "#111",
          }}
        >
          {data.productName || "UNKNOWN PRODUCT"}
        </h1>
        <div style={{ display: "flex", gap: 24, marginTop: 4 }}>
          {data.casNumber && (
            <span
              data-testid="label-cas-number"
              style={{ fontSize: 13, fontWeight: 700, color: "#555" }}
            >
              CAS No.&nbsp;{data.casNumber}
            </span>
          )}
          {data.chemicalFormula && (
            <span
              data-testid="label-formula"
              style={{ fontSize: 13, fontWeight: 700, color: "#555" }}
            >
              {data.chemicalFormula}
            </span>
          )}
        </div>
      </div>

      {/* ── 2. 중단 본문: 픽토그램 + 문구 ──────────────────── */}
      <div
        style={{
          display: "flex",
          borderBottom: "4px solid #cc0000",
        }}
      >
        {/* 왼쪽: 픽토그램 + 신호어 */}
        <div
          style={{
            width: 280,
            minWidth: 280,
            borderRight: "3px solid #cc0000",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
            padding: "24px 16px 16px",
            gap: 0,
          }}
        >
          {/* 픽토그램 격자 */}
          <div
            data-testid="label-pictograms"
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 10,
              marginBottom: 24,
            }}
          >
            {data.pictograms.length > 0 ? (
              data.pictograms.map((pic) => (
                <div
                  key={pic.code}
                  title={pic.name}
                  style={{ width: 110, height: 110 }}
                >
                  <GhsPictogramIcon
                    code={pic.code}
                    className="w-full h-full"
                  />
                </div>
              ))
            ) : (
              <div
                style={{
                  width: 110,
                  height: 110,
                  border: "2px dashed #ccc",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  color: "#aaa",
                }}
              >
                No Symbol
              </div>
            )}
          </div>

          {/* 신호어 */}
          <div
            style={{
              borderTop: "2px solid #eee",
              width: "100%",
              paddingTop: 16,
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "#888",
                marginBottom: 4,
              }}
            >
              {isKorean ? "신호어" : "Signal Word"}
            </div>
            <h2
              data-testid="label-signal-word"
              style={{
                fontSize: 52,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                margin: 0,
                color: isDanger ? "#cc0000" : "#222",
                lineHeight: 1,
              }}
            >
              {data.signalWord || (isKorean ? "경고" : "WARNING")}
            </h2>
          </div>
        </div>

        {/* 오른쪽: 유해문구 + 예방조치문구 */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* 유해·위험 문구 */}
          {data.hazardStatements.length > 0 && (
            <div
              data-testid="label-hazard-statements"
              style={{
                borderBottom: "2px solid #eee",
                padding: "16px 20px",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#cc0000",
                  marginBottom: 8,
                  borderBottom: "1.5px solid #cc0000",
                  paddingBottom: 4,
                }}
              >
                {isKorean ? "유해·위험 문구" : "Hazard Statements"}
              </div>
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {data.hazardStatements.map((stmt, idx) => (
                  <li
                    key={idx}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      lineHeight: 1.5,
                      color: "#222",
                      paddingLeft: 10,
                      borderLeft: "3px solid #cc0000",
                      marginBottom: 3,
                    }}
                  >
                    {stmt}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 예방조치 문구 */}
          {data.precautionaryStatements.length > 0 && (
            <div
              data-testid="label-precautionary-statements"
              style={{
                padding: "16px 20px",
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#333",
                  marginBottom: 8,
                  borderBottom: "1.5px solid #333",
                  paddingBottom: 4,
                }}
              >
                {isKorean ? "예방조치 문구" : "Precautionary Statements"}
              </div>
              <div
                style={{
                  columnCount: data.precautionaryStatements.length > 6 ? 2 : 1,
                  columnGap: 16,
                }}
              >
                {data.precautionaryStatements.map((stmt, idx) => (
                  <div
                    key={idx}
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "#333",
                      marginBottom: 3,
                      breakInside: "avoid",
                      paddingLeft: 8,
                      borderLeft: "2px solid #bbb",
                    }}
                  >
                    {stmt}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 3. 하단 푸터: 공급자 정보 ───────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "stretch",
          padding: "12px 24px",
          backgroundColor: "#fff8f8",
          minHeight: 80,
          gap: 24,
        }}
      >
        <div
          data-testid="label-supplier"
          style={{ flex: 1 }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "#cc0000",
              marginBottom: 4,
            }}
          >
            {isKorean ? "공급자 정보" : "Supplier Information"}
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: "pre-wrap",
              color: "#222",
              lineHeight: 1.5,
            }}
          >
            {data.supplier || (isKorean ? "공급자 정보 없음" : "Supplier information not provided")}
          </div>
        </div>

        {data.emergencyPhone && (
          <div
            data-testid="label-emergency-phone"
            style={{
              textAlign: "right",
              borderLeft: "2px solid #ddd",
              paddingLeft: 20,
              minWidth: 200,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "#555",
                marginBottom: 4,
              }}
            >
              {isKorean ? "비상 연락처" : "Emergency Contact"}
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 900,
                color: "#cc0000",
                letterSpacing: "0.02em",
                whiteSpace: "nowrap",
              }}
            >
              {data.emergencyPhone}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
