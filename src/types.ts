export interface GhsPictogram {
  code: string;
  name: string;
}

export interface GhsData {
  productName: string;
  supplier: string;
  signalWord: string;
  pictograms: GhsPictogram[];
  hazardStatements: string[];
  precautionaryStatements: string[];
  casNumber: string | null;
  chemicalFormula: string | null;
  emergencyPhone: string | null;
  language: string;
}
