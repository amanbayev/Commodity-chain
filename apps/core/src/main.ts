import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

const application = await NestFactory.create(AppModule);
application.setGlobalPrefix('v1');
application.enableShutdownHooks();

await application.listen(3000);
