import { NestFactory } from '@nestjs/core';
import * as compression from 'compression';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WinstonModule } from 'nest-winston';
import { instance } from './utils/loggers/winston.logger';
import { AllExceptionsFilter } from './common/helper/all-exceptions';
import { apiReference } from '@scalar/nestjs-api-reference';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger({
      instance: instance,
    }),
  });
  app.setGlobalPrefix('/api');
  if (process.env.NODE_ENV === 'development') {
    const config = new DocumentBuilder()
      .setTitle('Servicio de almacenamiento de Archivos V1')
      .setDescription(
        'Servicio para el almacenamiento de imagenes y documentos',
      )
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    /*SwaggerModule.setup('/api/docs', app, document); // Cambia la ruta de Swagger a /api/docs*/
    app.use('/api/docs',apiReference({content: document, pageTitle: 'API Documentation'}),);
  }
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // forbidNonWhitelisted: true,
    }),
  );
  app.use(compression());
  app.enableCors();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(process.env.PORT || 4000);
  console.log(`Server is running on port ${process.env.PORT || 4000}`);
}
bootstrap();
