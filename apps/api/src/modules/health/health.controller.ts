import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/common/decorators/auth.decorators';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import { RedisService } from 'src/modules/redis/redis.service';

/**
 * Health probes.
 *
 * Two endpoints, because Kubernetes asks two different questions and conflating
 * them causes outages:
 *
 *   • /health/live  — "is the process alive?" A failure here gets the container
 *     killed and restarted. It must NOT touch the database: if Postgres blips,
 *     a liveness check that depends on it will cheerfully restart every API pod
 *     at once, turning a brief database wobble into a full outage.
 *
 *   • /health/ready — "can it serve traffic?" A failure here just pulls the pod
 *     out of the load balancer until its dependencies come back. This one *does*
 *     check Postgres and Redis.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe. Never touches dependencies.' })
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe. Checks Postgres and Redis.' })
  async ready() {
    const [database, cache] = await Promise.all([
      this.prisma.ping().catch(() => false),
      this.redis.ping().catch(() => false),
    ]);

    const healthy = database && cache;

    return {
      status: healthy ? 'ok' : 'degraded',
      checks: {
        database: database ? 'up' : 'down',
        redis: cache ? 'up' : 'down',
      },
    };
  }
}
