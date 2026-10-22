import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export const IMPORT_ACCEPT = ".txt,.md,.markdown,.vtt,.pdf,.docx,.xlsx,.csv,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const IMPORT_FORMATS = ".pdf, .docx, .xlsx, .csv, .txt, .md, .vtt";
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const validExtension = /\.(txt|md|markdown|vtt|pdf|docx|xlsx|csv)$/i;
const plainTextExtension = /\.(txt|md|markdown|vtt)$/i;

export function isImportableFile(file: File): boolean {
  return validExtension.test(file.name);
}

export function titleFromImport(fileName: string): string {
  return fileName.replace(validExtension, "").replace(/[_-]+/g, " ").trim().slice(0, 160);
}

/** Extracts editable text locally in the browser. Only the extracted text is sent to the workspace API. */
export async function extractImportFile(
  file: File,
  options: { format: "markdown" | "text"; maxChars: number; maxBytes?: number },
): Promise<string> {
  if (!isImportableFile(file)) throw new Error(`Unsupported file type. Use ${IMPORT_FORMATS}. Legacy .doc and .xls must be saved as .docx or .xlsx.`);
  if (file.size > (options.maxBytes ?? MAX_IMPORT_BYTES)) throw new Error(`File is too large. Maximum size is ${Math.round((options.maxBytes ?? MAX_IMPORT_BYTES) / 1024 / 1024)} MB.`);
  if (file.size === 0) throw new Error("The file is empty.");

  let content: string;
  if (plainTextExtension.test(file.name)) {
    content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, "");
    if (content.includes("\0")) throw new Error("The file is not valid UTF-8 text.");
  } else {
    const { OfficeParser } = await import("officeparser/slim");
    const document = await OfficeParser.parseOffice(file, {
      allowRemoteAssets: false,
      pdfWorkerSrc: pdfWorkerUrl,
      extractAttachments: false,
      ocr: false,
      decompressionLimits: {
        maxUncompressedBytes: 30 * 1024 * 1024,
        maxZipEntries: 2000,
        maxTableCells: 50_000,
        maxXmlElements: 250_000,
        maxRepeatedContent: 2_000_000,
        maxRawContentLength: 2_000_000,
      },
    });
    content = String((await document.to(options.format === "markdown" ? "md" : "text")).value ?? "");
  }
  if (!content.trim()) throw new Error("No readable text was found. Scanned PDFs need OCR, which is not connected yet.");
  if (content.length > options.maxChars) throw new Error(`Extracted text exceeds ${options.maxChars.toLocaleString()} characters. Split or shorten the file before importing.`);
  return content;
}
