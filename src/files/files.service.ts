import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { extname } from 'path';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { createGunzip } from 'zlib';
import { Response } from 'express';

import { StorageService } from '../storage/storage.service';
import { compressBuffer } from '../common/helper/compression.helper';

const WATERMARK_TEXT = 'POLICIA BOLIVIANA';
const MAX_WATERMARK_TEXT_LENGTH = 120;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

type PdfMode = 'original' | 'watermarked';
type RetentionMode = 'permanent' | 'temporary';

interface UploadOptions {
  pdfMode?: string;
  watermarkText?: string;
  retentionMode?: string;
  retentionDays?: string;
}

interface NormalisedUploadOptions {
  pdfMode: PdfMode;
  watermarkText: string;
  retentionMode: RetentionMode;
  expiresAt?: string;
}

interface FileHashRecord {
  key: string;
  hash: string;
  pdfVariant?: PdfMode;
}

export interface StoredFile {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  watermarked: boolean;
  downloadUrl: string;
  viewUrl: string;
  path: string;
  compressed: boolean;
  retention: RetentionMode;
  expiresAt?: string;
  sha256?: string;
}

export interface ProcessedDocumentResponse {
  statusCode: number;
  message: string;
  data: {
    objectKey: string;
    bucket: string;
    path: string;
    sha256: string;
  };
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  private readonly stirlingPdfUrl = (
    process.env.STIRLING_PDF_URL || 'http://stirling-pdf:8080'
  ).replace(/\/$/, '');

  private readonly publicApiUrl = (
    process.env.PUBLIC_API_URL || 'http://localhost:4000'
  ).replace(/\/$/, '');

  constructor(private readonly storage: StorageService) {}

  async processDocument(
    file: Express.Multer.File,
    watermarkText?: string,
  ): Promise<ProcessedDocumentResponse> {
    if (!file) {
      throw new BadRequestException('Debe proporcionar un archivo PDF.');
    }

    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('El archivo debe ser un documento PDF.');
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        'El archivo PDF supera el tamaño máximo permitido de 50 MB.',
      );
    }

    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('El archivo PDF está vacío.');
    }

    const finalWatermark = (
      watermarkText || WATERMARK_TEXT
    ).trim();

    if (!finalWatermark) {
      throw new BadRequestException('La marca de agua no puede estar vacía.');
    }

    if (finalWatermark.length > MAX_WATERMARK_TEXT_LENGTH) {
      throw new BadRequestException(
        `La marca de agua no puede superar ${MAX_WATERMARK_TEXT_LENGTH} caracteres.`,
      );
    }

    const sha256 = this.calculateHash(file.buffer);

    await this.assertCanStoreFile(
      sha256,
      'watermarked',
      true,
    );

    const watermarkedPdf = await this.addWatermark(
      file,
      finalWatermark,
    );

    const compressedPdf = await this.compressPdfWithStirling(
      watermarkedPdf,
      file.originalname,
    );

    const uuid = randomUUID();
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0');

    const objectKey = `${year}/${month}/${uuid}-documento.pdf`;
    const storageKey = `archivos/${objectKey}`;

    await this.storage.put(
      storageKey,
      compressedPdf,
      'application/pdf',
      {
        originalname: encodeURIComponent(
          file.originalname || 'documento.pdf',
        ),
        watermarked: 'true',
        compressed: 'false',
        originalsize: String(
          compressedPdf.length,
        ),
        retention: 'permanent',
        expiresat: '',
        sha256,
        pdfvariant: 'watermarked',
      },
    );

    const id = this.storage.encodeId(storageKey);
    const path = storageKey; /* `${this.publicApiUrl}/api/files/${id}`; */
    this.logger.log(
      `Documento procesado correctamente. key=${storageKey}, sha256=${sha256}`,
    );

    return {
      statusCode: 200,
      message: 'Documento procesado y almacenado exitosamente',
      data: {
        objectKey,
        bucket:
          process.env.S3_BUCKET ||
          'archivos-policiales',
        path,
        sha256,
      },
    };
  }

  async upload(files: Express.Multer.File[],input: UploadOptions = {},): Promise<StoredFile[]> {
    if (!files?.length) {
      throw new BadRequestException(
        'Debe seleccionar al menos un archivo.',
      );
    }

    const options = this.normaliseUploadOptions(input);
    try {
      const results: StoredFile[] = [];

      for (const file of files) {
        const stored = await this.store(file,options,);results.push(stored);}

      this.logger.log(
        `Se almacenaron ${results.length} archivos en MinIO.`,
      );
      return results;
    } catch (error) {
      this.logger.error(
        `Error al subir archivos: ${error instanceof Error? error.message: String(error)
        }`,
      );
      throw error;
    }
  }

  async list(): Promise<StoredFile[]> {
    const objects = await this.storage.list();
    return Promise.all(
      objects.map(async (object) => {
        const metadata = await this.storage.metadata(object.key,);
        const displaySize = metadata.originalSize? Number(metadata.originalSize): object.size;
        return this.toStoredFile(
          object.key,
          this.originalName(object.key,metadata.originalName,),
          metadata.contentType ||'application/octet-stream',
          Number.isFinite(displaySize)? displaySize: object.size,
          object.lastModified?.toISOString() || new Date().toISOString(),
          metadata.watermarked === 'true',
          metadata.compressed === 'true',
          metadata.retention === 'temporary'? 'temporary': 'permanent',
          metadata.expiresAt || undefined,metadata.sha256 || undefined,
        );
      }),
    );
  }
  async download(id: string,response: Response,disposition?: string,): Promise<void> {
    const key = this.storage.decodeId(id);
    const metadata = await this.storage.metadata(key);
    const fileName = this.originalName(key,metadata.originalName,);
    const object = await this.storage.get(key);
    const contentDisposition =disposition === 'inline'? 'inline': 'attachment';
    const isCompressed =metadata.compressed === 'true';
    try {
      response.setHeader('Content-Disposition',`${contentDisposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,);
      response.setHeader('Content-Type',metadata.contentType ||'application/octet-stream',);
      if (!isCompressed && object.ContentLength) {
        response.setHeader('Content-Length',object.ContentLength,);
      } else if (isCompressed&&metadata.originalSize) {
        response.setHeader(
          'Content-Length',
          metadata.originalSize,
        );
      }

      await new Promise<void>((resolve, reject) => {
        const stream = object.Body as Readable;
        const output = isCompressed? stream.pipe(createGunzip()): stream;
        stream.on('error', reject);
        output.on('error', reject);
        response.on('error', reject);
        response.on('finish', resolve);
        output.pipe(response);
      });
    } catch (error) {
      this.logger.error(
        `Error al descargar ${key}: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );

      if (!response.headersSent) {
        throw new NotFoundException(
          'El archivo no existe o no está disponible.',
        );
      }
    }
  }

  async remove(id: string): Promise<void> {
    const key = this.storage.decodeId(id);
    const metadata = await this.storage.metadata(key);
    await Promise.all([
      this.storage.remove(key),
      ...(metadata.originalKey
        ? [
            this.storage.remove(
              metadata.originalKey,
            ),
          ]
        : []),
    ]);
  }

  private async store(file: Express.Multer.File,options: NormalisedUploadOptions,): Promise<StoredFile> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException(
        'El archivo está vacío o no es válido.',
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        'El archivo supera el tamaño máximo permitido de 50 MB.',
      );
    }

    const pdf = this.isPdf(file);
    const sha256 = this.calculateHash(file.buffer,);
    const pdfVariant = pdf
      ? options.pdfMode: undefined;

    await this.assertCanStoreFile(sha256,pdfVariant,pdf,);

    const watermarked =pdf && options.pdfMode === 'watermarked';
    const contents = watermarked
      ? await this.addWatermark(file,options.watermarkText,) : file.buffer;

    const contentType = pdf
    ? 'application/pdf': file.mimetype ||'application/octet-stream';

    const key = this.storage.createKey(file.originalname,);
    const compression = compressBuffer(contents);

    await this.storage.put(key,compression.buffer,contentType,{
        originalname: encodeURIComponent(
          file.originalname,
        ),
        watermarked: String(watermarked),
        compressed: String(
          compression.compressed,
        ),
        originalsize: String(
          compression.originalSize,
        ),
        retention: options.retentionMode,
        expiresat: options.expiresAt || '',
        sha256,
        pdfvariant: pdfVariant || '',
      },
    );

    this.logger.log(`Archivo almacenado correctamente. key=${key}, sha256=${sha256}`,);
    return this.toStoredFile(key,file.originalname,contentType,compression.originalSize,new Date().toISOString(),watermarked,compression.compressed,options.retentionMode,options.expiresAt,);
  }

  private calculateHash(buffer: Buffer): string {
    return createHash('sha256')
      .update(buffer)
      .digest('hex');
  }

  private async findByHash(
    hash: string,
  ): Promise<FileHashRecord[]> {
    const objects = await this.storage.list();
    const matches: FileHashRecord[] = [];

    for (const object of objects) {
      const metadata = await this.storage.metadata(
        object.key,
      );
      if (metadata.sha256 !== hash) {continue;}
      const pdfVariant = metadata.pdfVariant;
      matches.push({key: object.key,hash,
        pdfVariant:pdfVariant === 'original'||pdfVariant === 'watermarked'? pdfVariant: undefined,});
    }

    return matches;
  }

  private async assertCanStoreFile(hash: string,pdfVariant?: PdfMode,isPdf = false,): Promise<void> {
    const matches = await this.findByHash(hash);
    if (!isPdf) {
      if (matches.length > 0) {
        throw new BadRequestException(
          'El archivo ya existe en el sistema. No se permiten archivos duplicados.',
        );
      }
      return;
    }

    const sameVariantExists = matches.some(
      (match) =>
        match.pdfVariant === pdfVariant,
    );

    if (sameVariantExists) {
      const label =
        pdfVariant === 'watermarked'
          ? 'con marca de agua'
          : 'original';

      throw new BadRequestException(
        `El documento PDF ${label} ya existe en el sistema. No se permiten versiones duplicadas.`,
      );
    }
  }

  private async addWatermark(
    file: Express.Multer.File,
    watermarkText: string,
  ): Promise<Buffer> {
    const form = new FormData();

    form.append('fileInput',new Blob([file.buffer],{ type: 'application/pdf' },),file.originalname,);

    form.append('customColor', '#000000');
    form.append('watermarkColor', '#000000');
    form.append('watermarkType', 'text');
    form.append('watermarkText', watermarkText);
    form.append('alphabet', 'roman');
    form.append('fontSize', '44');
    form.append('rotation', '0');
    form.append('opacity', '0.22');
    form.append('widthSpacer', '80');
    form.append('heightSpacer', '80');

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      120_000,
    );

    try {
      const apiKey =
        process.env.STIRLING_PDF_API_KEY;

      const result = await fetch(
        `${this.stirlingPdfUrl}/api/v1/security/add-watermark`,
        {
          method: 'POST',
          body: form,
          headers: apiKey
            ? {
                'X-API-KEY': apiKey,
              }
            : undefined,
          signal: controller.signal,
        },
      );

      if (!result.ok) {
        const detail = (
          await result.text()
        ).slice(0, 400);

        this.logger.error(
          `Stirling PDF respondió ${result.status}: ${detail}`,
        );

        throw new BadGatewayException(
          'No fue posible aplicar la marca de agua al PDF. No se guardó el archivo.',
        );
      }

      const processed = Buffer.from(
        await result.arrayBuffer(),
      );

      if (!processed.length) {
        throw new BadGatewayException(
          'Stirling PDF devolvió un archivo vacío. No se guardó el archivo.',
        );
      }

      return processed;
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }

      this.logger.error(
        `No se pudo conectar con Stirling PDF: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );

      throw new BadGatewayException(
        'El servicio de protección de PDF no está disponible. No se guardó el archivo.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async compressPdfWithStirling(
    buffer: Buffer,
    originalName: string,
  ): Promise<Buffer> {
    const form = new FormData();

    form.append(
      'fileInput',
      new Blob(
        [buffer],
        { type: 'application/pdf' },
      ),
      originalName || 'documento.pdf',
    );

    form.append('optimizeLevel', '5');
    form.append('grayscale', 'false');
    form.append('linearize', 'false');
    form.append('lineArt', 'false');

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      120_000,
    );

    try {const apiKey =process.env.STIRLING_PDF_API_KEY;

      const result = await fetch(
        `${this.stirlingPdfUrl}/api/v1/misc/compress-pdf`,
        {
          method: 'POST',
          body: form,
          headers: apiKey
            ? {
                'X-API-KEY': apiKey,
              }
            : undefined,
          signal: controller.signal,
        },
      );

      if (!result.ok) {
        const detail = (
          await result.text()
        ).slice(0, 400);

        this.logger.error(
          `Stirling PDF compression respondió ${result.status}: ${detail}`,
        );

        throw new BadGatewayException('No fue posible comprimir el PDF. No se guardó el archivo.',);}
      const processed = Buffer.from(await result.arrayBuffer(),);
      if (!processed.length) {
        throw new BadGatewayException(
          'Stirling PDF devolvió un PDF comprimido vacío.',
        );
      }

      return processed;
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }

      this.logger.error(`No se pudo conectar con Stirling PDF para comprimir: ${error instanceof Error? error.message: String(error)}`,);

      throw new BadGatewayException('El servicio de compresión de PDF no está disponible. No se guardó el archivo.',);
    } finally {
      clearTimeout(timeout);
    }
  }

  private normaliseUploadOptions(
    input: UploadOptions,
  ): NormalisedUploadOptions {
    const pdfMode =
      input.pdfMode || 'watermarked';

    if (pdfMode !== 'original' &&pdfMode !== 'watermarked') {
      throw new BadRequestException('El modo de almacenamiento para PDF no es válido.',);
    }

    const watermarkText = (input.watermarkText ||WATERMARK_TEXT).trim();

    if (pdfMode === 'watermarked' &&!watermarkText) {
      throw new BadRequestException('La marca de agua para PDF no puede estar vacía.',);
    }

    if (watermarkText.length >MAX_WATERMARK_TEXT_LENGTH) {
      throw new BadRequestException(`La marca de agua no puede superar ${MAX_WATERMARK_TEXT_LENGTH} caracteres.`,);
    }

    const retentionMode: RetentionMode =input.retentionMode === 'temporary'? 'temporary': 'permanent';
    let expiresAt: string | undefined;
    if (retentionMode === 'temporary') {
      const days = Number(input.retentionDays,);

      if (!Number.isFinite(days) ||days < MIN_RETENTION_DAYS ||days > MAX_RETENTION_DAYS) {
        throw new BadRequestException(`Indique un lapso de conservación válido, entre ${MIN_RETENTION_DAYS} y ${MAX_RETENTION_DAYS} días.`,);
      }
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + days,);
      expiresAt = expiry.toISOString();
    }
    return {pdfMode: pdfMode as PdfMode,watermarkText,retentionMode,expiresAt,};
  }

  private isPdf(file: Express.Multer.File,): 
  boolean {return (file.mimetype === 'application/pdf'||extname(file.originalname,).toLowerCase() === '.pdf');
  }

  private toStoredFile(key: string,fileName: string,contentType: string,size: number,uploadedAt: string,watermarked: boolean,compressed: boolean,retention: RetentionMode,expiresAt?: string,sha256?: string,): StoredFile {
    const id = this.storage.encodeId(key);
    const downloadUrl = `/api/files/${id}`;
    const path = `${this.publicApiUrl}/api/files/${id}`;
    return {id,fileName,contentType,size,uploadedAt,watermarked,downloadUrl,viewUrl: `${downloadUrl}?disposition=inline`,path,compressed,retention,expiresAt,sha256,};
  }

  private originalName(key: string,encodedName?: string,): string {
    if (encodedName) {
      try {
        return decodeURIComponent(encodedName,);
      } catch {
        // Ignorar metadatos corruptos.
      }
    }
    return key.substring(key.lastIndexOf('-') + 1,);
  }
}