import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { basename, extname } from 'path';

export interface ObjectSummary {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface ObjectMetadata {
  contentType?: string;
  originalName?: string;
  watermarked?: string;
  originalKey?: string;
  compressed?: string;
  originalSize?: string;
  retention?: string;
  expiresAt?: string;
  sha256?: string;
  pdfVariant?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  private readonly bucket =
    process.env.S3_BUCKET || 'archivos-policiales';

  private readonly client = new S3Client({
    endpoint:
      process.env.S3_ENDPOINT ||
      'http://minio:9000',
    region:
      process.env.S3_REGION ||
      'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId:
        process.env.S3_ACCESS_KEY ||
        'minioadmin',
      secretAccessKey:
        process.env.S3_SECRET_KEY ||
        'minioadmin',
    },
  });

  async onModuleInit(): Promise<void> {
    for (
      let attempt = 1;
      attempt <= 20;
      attempt += 1
    ) {
      try {
        await this.ensureBucket();
        return;
      } catch (error) {
        if (attempt === 20) {
          throw error;
        }

        this.logger.warn(
          `MinIO aún no está disponible (intento ${attempt}/20). Reintentando…`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, 1000),
        );
      }
    }
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: metadata,
      }),
    );
  }

  async get(key: string) {
    try {
      return await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      if (this.isNotFound(error)) {
        throw new NotFoundException(
          'El archivo solicitado no existe.',
        );
      }

      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async list(): Promise<ObjectSummary[]> {
    const objects: ObjectSummary[] = [];

    let continuationToken:
      | string
      | undefined;

    const MAX_OBJECTS = 5000;

    do {
      const result =
        await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: 'archivos/',
            MaxKeys: 1000,
            ContinuationToken:
              continuationToken,
          }),
        );

      for (
        const entry of
        result.Contents || []
      ) {
        if (!entry.Key) {
          continue;
        }

        objects.push({
          key: entry.Key,
          size: entry.Size || 0,
          lastModified:
            entry.LastModified,
        });
      }

      continuationToken =
        result.IsTruncated
          ? result.NextContinuationToken
          : undefined;
    } while (
      continuationToken &&
      objects.length < MAX_OBJECTS
    );

    return objects.sort(
      (first, second) =>
        (second.lastModified?.getTime() ||
          0) -
        (first.lastModified?.getTime() ||
          0),
    );
  }

  async metadata(
    key: string,
  ): Promise<ObjectMetadata> {
    try {
      const result =
        await this.client.send(
          new HeadObjectCommand({
            Bucket: this.bucket,
            Key: key,
          }),
        );

      return {
        contentType:
          result.ContentType,

        originalName:
          result.Metadata?.originalname,

        watermarked:
          result.Metadata?.watermarked,

        originalKey:
          result.Metadata?.originalkey,

        compressed:
          result.Metadata?.compressed,

        originalSize:
          result.Metadata?.originalsize,

        retention:
          result.Metadata?.retention,

        expiresAt:
          result.Metadata?.expiresat,

        sha256:
          result.Metadata?.sha256,

        pdfVariant:
          result.Metadata?.pdfvariant,
      };
    } catch (error) {
      if (this.isNotFound(error)) {
        throw new NotFoundException(
          'El archivo solicitado no existe.',
        );
      }

      throw error;
    }
  }

  createKey(
    originalName: string,
  ): string {
    const date =
      new Date()
        .toISOString()
        .slice(0, 10);

    const extension =
      extname(
        originalName,
      ).toLowerCase();

    const name =
      basename(
        originalName,
        extension,
      )
        .normalize('NFD')
        .replace(
          /[\u0300-\u036f]/g,
          '',
        )
        .replace(
          /[^a-zA-Z0-9._-]/g,
          '-',
        )
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) ||
      'archivo';

    const safeExtension =
      /^[.][a-zA-Z0-9]{1,10}$/.test(
        extension,
      )
        ? extension
        : '';

    return `archivos/${date}/${randomUUID()}-${name}${safeExtension}`;
  }

  createOriginalKey(
    key: string,
  ): string {
    if (
      !key.startsWith(
        'archivos/',
      )
    ) {
      throw new BadRequestException(
        'La ubicación del archivo no es válida.',
      );
    }

    return `originales/${key.substring(
      'archivos/'.length,
    )}`;
  }

  encodeId(key: string): string {
    return Buffer.from(
      key,
    ).toString('base64url');
  }

  decodeId(id: string): string {
    try {
      const key =
        Buffer.from(
          id,
          'base64url',
        ).toString('utf8');

      if (
        !key.startsWith(
          'archivos/',
        ) ||
        key.includes('..')
      ) {
        throw new Error(
          'Identificador fuera del espacio permitido.',
        );
      }

      return key;
    } catch {
      throw new BadRequestException(
        'El identificador del archivo no es válido.',
      );
    }
  }

  private async ensureBucket(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({
          Bucket: this.bucket,
        }),
      );
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }

      try {
        await this.client.send(
          new CreateBucketCommand({
            Bucket: this.bucket,
          }),
        );

        this.logger.log(
          `Bucket «${this.bucket}» creado.`,
        );
      } catch (createError) {
        if (
          !this.isAlreadyExists(
            createError,
          )
        ) {
          throw createError;
        }
      }
    }
  }

  private isNotFound(
    error: unknown,
  ): boolean {
    const code =
      (
        error as {
          name?: string;
          Code?: string;
        }
      )?.name ||
      (
        error as {
          Code?: string;
        }
      )?.Code;

    return ['NotFound','NoSuchBucket','NoSuchKey','404',].includes(code || '');
  }

  private isAlreadyExists(
    error: unknown,
  ): boolean {
    const code =
      (
        error as {
          name?: string;
          Code?: string;
        }
      )?.name ||
      (
        error as {
          Code?: string;
        }
      )?.Code;

    return [
      'BucketAlreadyOwnedByYou',
      'BucketAlreadyExists',
    ].includes(code || '');
  }
}