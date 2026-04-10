import React from "react";

const BASE = import.meta.env.BASE_URL;

export function GhsPictogramIcon({ code, className }: { code: string; className?: string }) {
  return (
    <img
      src={`${BASE}pictograms/${code}.svg`}
      alt={code}
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
}
