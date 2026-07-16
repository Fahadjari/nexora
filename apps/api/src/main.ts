import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Keeps the untouched request bytes on `req.rawBody`.
    //
    // Required by the payment webhook: the provider signs the exact bytes it
    // sent, and `JSON.parse` followed by `JSON.stringify` does not reproduce
    // them — key order and unicode escaping both drift. Verifying against a
    // re-serialised body fails for every legitimate webhook, and the "fix"
    // someone inevitably reaches for is to stop verifying at all.
    rawBody: true,
  });

  const config = app.get(ConfigService<AppConfig, true>);
  const logger = new Logger('Bootstrap');
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  // Security headers. CSP is off because this process serves JSON, not HTML —
  // a CSP here protects nobody and only breaks the Swagger UI.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.enableCors({
    origin: config.get('WEB_URL', { infer: true }),
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties with no matching DTO field. Without this, a client can
      // POST `{ "aiScore": 100 }` and Prisma will happily persist it — mass
      // assignment, straight into a column the user is not allowed to write.
      whitelist: true,
      // And be loud about it rather than silently dropping, so a mistaken client
      // finds out immediately.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Swagger in non-production only. The schema is a map of every endpoint and
  // field in the system — useful to us, and equally useful to an attacker.
  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Nexora API')
      .setDescription('AI Business Operating System for SMBs.')
      .setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build();

    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Let Nest run onModuleDestroy hooks (close the DB pool, drain the queues)
  // when the orchestrator sends SIGTERM, instead of dropping in-flight work.
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  logger.log(`Nexora API listening on http://localhost:${port}/api/v1`);
  if (!isProduction) {
    logger.log(`API docs at http://localhost:${port}/api/docs`);
  }
}

void bootstrap();
