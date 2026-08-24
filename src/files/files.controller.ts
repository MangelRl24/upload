import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';

import { FilesService } from './files.service';

import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  FileInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';

import { memoryStorage } from 'multer';
import { Response } from 'express';

const MAX_FILES_PER_REQUEST = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

@ApiTags('Archivos')
@Controller()
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  // ============================================================
  // NUEVO ENDPOINT
  // POST /api/v1/documents/process
  // ============================================================

  @Post('v1/documents/process')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: MAX_FILE_SIZE,
      },
      fileFilter: (_request, file, callback) => {
        if (!file.originalname?.trim()) {
          callback(
            new Error('El archivo debe tener un nombre.'),
            false,
          );
          return;
        }

        callback(null, true);
      },
    }),
  )
  @ApiOperation({
    summary: 'Procesa y almacena un documento PDF',
    description:
      'Recibe un PDF, valida su tipo, aplica una marca de agua mediante Stirling-PDF, comprime el PDF mediante Stirling-PDF y finalmente lo almacena en MinIO.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description:
      'Archivo PDF y texto opcional para la marca de agua.',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Documento PDF a procesar.',
        },
        watermarkText: {
          type: 'string',
          maxLength: 120,
          example: 'POLICIA BOLIVIANA',
          description:
            'Texto opcional que será utilizado como marca de agua.',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Documento procesado y almacenado exitosamente.',
    schema: {
      example: {
        statusCode: 200,
        message:
          'Documento procesado y almacenado exitosamente',
        data: {
          objectKey:
            '2026/08/550e8400-e29b-41d4-a716-446655440000-documento.pdf',
          bucket: 'policia-docs',
          path:
            'http://localhost:4000/api/files/encoded-object-id',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'El archivo no existe o no es un PDF.',
  })
  @ApiResponse({
    status: 502,
    description:
      'No fue posible procesar el documento mediante Stirling-PDF.',
  })
  async processDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body('watermarkText') watermarkText?: string,
  ) {
    return this.filesService.processDocument(
      file,
      watermarkText,
    );
  }

  // ============================================================
  // ENDPOINT EXISTENTE
  // POST /api/files
  // ============================================================

  @ApiOperation({
    summary:
      'Sube archivos de cualquier formato a MinIO',
    description:
      'Los PDF pueden guardarse originales o procesarse con una marca de agua personalizada. Los demás formatos se almacenan sin modificaciones.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          maxItems: MAX_FILES_PER_REQUEST,
          items: {
            type: 'string',
            format: 'binary',
          },
        },
        pdfMode: {
          type: 'string',
          enum: ['original', 'watermarked'],
          default: 'watermarked',
          description:
            'Modo de almacenamiento para los archivos PDF.',
        },
        watermarkText: {
          type: 'string',
          maxLength: 120,
          description:
            'Texto de la marca de agua cuando pdfMode es watermarked.',
        },
        retentionMode: {
          type: 'string',
          enum: ['permanent', 'temporary'],
          default: 'permanent',
          description:
            'Política de conservación.',
        },
        retentionDays: {
          type: 'number',
          description:
            'Cantidad de días cuando retentionMode es temporary.',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'Archivos almacenados correctamente.',
  })
  @Post('files')
  @UseInterceptors(
    FilesInterceptor(
      'files',
      MAX_FILES_PER_REQUEST,
      {
        storage: memoryStorage(),
        limits: {
          fileSize: MAX_FILE_SIZE,
          files: MAX_FILES_PER_REQUEST,
        },
        fileFilter: (
          _request,
          file,
          callback,
        ) => {
          if (!file.originalname?.trim()) {
            callback(
              new Error(
                'El archivo debe tener un nombre.',
              ),
              false,
            );
            return;
          }

          callback(null, true);
        },
      },
    ),
  )
  upload(
    @UploadedFiles()
    files: Array<Express.Multer.File>,

    @Body('pdfMode')
    pdfMode?: string,

    @Body('watermarkText')
    watermarkText?: string,

    @Body('retentionMode')
    retentionMode?: string,

    @Body('retentionDays')
    retentionDays?: string,
  ) {
    return this.filesService.upload(files, {
      pdfMode,
      watermarkText,
      retentionMode,
      retentionDays,
    });
  }

  // ============================================================
  // GET /api/files
  // ============================================================

  @ApiOperation({
    summary:
      'Lista los últimos archivos almacenados',
  })
  @Get('files')
  list() {
    return this.filesService.list();
  }

  // ============================================================
  // GET /api/files/:id
  // ============================================================

  @ApiOperation({
    summary:
      'Visualiza o descarga un archivo desde MinIO a través del API',
  })
  @Get('files/:id')
  download(
    @Param('id') id: string,
    @Query('disposition')
    disposition: string | undefined,
    @Res() response: Response,
  ) {
    return this.filesService.download(
      id,
      response,
      disposition,
    );
  }

  // ============================================================
  // DELETE /api/files/:id
  // ============================================================

  @ApiOperation({
    summary: 'Elimina un archivo de MinIO',
  })
  @Delete('files/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.filesService.remove(id);
  }
}