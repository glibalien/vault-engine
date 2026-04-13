import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Extractor, ExtractionResult } from '../types.js';

export class OfficeExtractor implements Extractor {
  readonly id = 'office-doc';
  readonly mediaType = 'office';
  readonly supportedExtensions = ['.docx', '.pptx', '.xlsx', '.csv'];

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    console.log(`[extraction:office] extracting ${ext} document`);
    let result: ExtractionResult;
    switch (ext) {
      case '.docx': result = await this.extractDocx(filePath); break;
      case '.pptx': result = await this.extractPptx(filePath); break;
      case '.xlsx': result = await this.extractXlsx(filePath); break;
      case '.csv': result = await this.extractCsv(filePath); break;
      default: throw new Error(`Unsupported office format: ${ext}`);
    }
    console.log(`[extraction:office] ${ext} extraction complete: ${result.text.length} chars`);
    return result;
  }

  private async extractDocx(filePath: string): Promise<ExtractionResult> {
    const mammoth = await import('mammoth');
    const buffer = await readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }

  private async extractPptx(filePath: string): Promise<ExtractionResult> {
    const officeparser = await import('officeparser');
    const ast = await officeparser.parseOffice(filePath);
    return { text: ast.toText() };
  }

  private async extractXlsx(filePath: string): Promise<ExtractionResult> {
    const XLSX = await import('xlsx');
    const buffer = await readFile(filePath);
    const workbook = XLSX.read(buffer);
    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (workbook.SheetNames.length > 1) {
        lines.push(`## ${sheetName}\n${csv}`);
      } else {
        lines.push(csv);
      }
    }
    return { text: lines.join('\n\n') };
  }

  private async extractCsv(filePath: string): Promise<ExtractionResult> {
    const text = await readFile(filePath, 'utf-8');
    return { text };
  }
}
