declare module "qrcode" {
  export function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
  const QRCode: { toDataURL: typeof toDataURL };
  export default QRCode;
}
