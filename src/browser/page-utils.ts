import type { CdpSender } from "./snapshot.js";

const MAX_PDF_BASE64_CHARS = 16 * 1024 * 1024;

type PrintPdfResponse = { data?: string };

export class PageUtilitiesController {
  constructor(private readonly cdp: CdpSender) {}

  async handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<void> {
    if (promptText !== undefined && promptText.length > 20_000) throw new Error("Dialog prompt text is too large");
    await this.cdp.send(tabId, "Page.handleJavaScriptDialog", {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  }

  async printPdf(tabId: number, landscape = false): Promise<{ data: string; truncated: boolean }> {
    const response = await this.cdp.send(tabId, "Page.printToPDF", {
      landscape,
      printBackground: true,
      preferCSSPageSize: true,
      transferMode: "ReturnAsBase64",
    }) as PrintPdfResponse;
    const raw = response.data ?? "";
    if (raw.length <= MAX_PDF_BASE64_CHARS) return { data: raw, truncated: false };
    return { data: raw.slice(0, MAX_PDF_BASE64_CHARS), truncated: true };
  }
}
