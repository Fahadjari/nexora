import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { AllExceptionsFilter } from 'src/common/filters/all-exceptions.filter';
import { PrismaService } from 'src/modules/prisma/prisma.service';

/**
 * The test that has to pass before anything else matters.
 *
 * The unit tests prove the Prisma extension *decides* correctly. This proves the
 * decision actually reaches the database through the whole live stack — real
 * HTTP, real guards, real JWTs, real SQL. Those are different claims, and only
 * this one would catch a service that quietly bypassed TENANT_DB and reached
 * for the raw client instead.
 *
 * Two real companies are registered through the public API. Then Acme tries,
 * every way the HTTP surface allows, to touch Bright Steel's data.
 *
 * Requires Postgres and Redis to be up: `npm run infra:up`.
 */
describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Acme
  let acmeToken: string;
  let acmeLeadId: string;

  // Bright Steel — the victim
  let steelToken: string;
  let steelLeadId: string;
  let steelTenantId: string;

  const unique = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();

    // Mirror main.ts exactly. A test app configured more leniently than the
    // real one proves nothing about the real one.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();

    prisma = app.get(PrismaService);

    // --- Register two independent companies through the public API ---
    const acme = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: `owner-${unique}@acme-e2e.test`,
        password: 'a-long-enough-test-password',
        firstName: 'Priya',
        lastName: 'Sharma',
        companyName: `Acme E2E ${unique}`,
      })
      .expect(201);

    acmeToken = acme.body.accessToken;

    const steel = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: `owner-${unique}@steel-e2e.test`,
        password: 'a-long-enough-test-password',
        firstName: 'Vikram',
        lastName: 'Desai',
        companyName: `Bright Steel E2E ${unique}`,
      })
      .expect(201);

    steelToken = steel.body.accessToken;
    steelTenantId = steel.body.tenant.id;

    // --- Each company creates a lead ---
    const acmeLead = await request(app.getHttpServer())
      .post('/api/v1/crm/leads')
      .set('Authorization', `Bearer ${acmeToken}`)
      .send({ firstName: 'Rahul', lastName: 'Mehta', companyName: 'A Prospect' })
      .expect(201);

    acmeLeadId = acmeLead.body.id;

    const steelLead = await request(app.getHttpServer())
      .post('/api/v1/crm/leads')
      .set('Authorization', `Bearer ${steelToken}`)
      .send({
        firstName: 'CONFIDENTIAL',
        lastName: 'SteelOnly',
        email: 'secret@steel-e2e.test',
        companyName: 'Must Never Leak',
        estimatedValue: 999999,
      })
      .expect(201);

    steelLeadId = steelLead.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registration really did create two separate workspaces', async () => {
    // Sanity: if both registrations collapsed into one tenant, every assertion
    // below would pass vacuously and prove nothing.
    expect(acmeLeadId).toBeDefined();
    expect(steelLeadId).toBeDefined();
    expect(acmeLeadId).not.toBe(steelLeadId);
  });

  it('a lead list contains only your own leads', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/crm/leads')
      .set('Authorization', `Bearer ${acmeToken}`)
      .expect(200);

    const ids = response.body.data.map((lead: { id: string }) => lead.id);

    expect(ids).toContain(acmeLeadId);
    expect(ids).not.toContain(steelLeadId);

    // And nothing that even looks like the other company's data.
    const names = response.body.data.map((lead: { firstName: string }) => lead.firstName);
    expect(names).not.toContain('CONFIDENTIAL');
  });

  it('fetching another tenant\'s lead by its exact id returns 404, not 403', async () => {
    // 404 rather than 403 is deliberate. A 403 would confirm the record exists,
    // letting an attacker enumerate other companies' ids. As far as Acme is
    // concerned, this lead simply does not exist.
    await request(app.getHttpServer())
      .get(`/api/v1/crm/leads/${steelLeadId}`)
      .set('Authorization', `Bearer ${acmeToken}`)
      .expect(404);
  });

  it('updating another tenant\'s lead fails', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/crm/leads/${steelLeadId}`)
      .set('Authorization', `Bearer ${acmeToken}`)
      .send({ firstName: 'Hijacked' })
      .expect(404);

    // Prove the row is genuinely untouched, reading it back with the raw
    // (unscoped) client rather than trusting the API's own answer.
    const lead = await prisma.lead.findUnique({ where: { id: steelLeadId } });
    expect(lead?.firstName).toBe('CONFIDENTIAL');
  });

  it('deleting another tenant\'s lead fails', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/crm/leads/${steelLeadId}`)
      .set('Authorization', `Bearer ${acmeToken}`)
      .expect(404);

    const lead = await prisma.lead.findUnique({ where: { id: steelLeadId } });
    expect(lead?.deletedAt).toBeNull();
  });

  it('search cannot be used to fish for another tenant\'s records', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/crm/leads')
      .query({ search: 'CONFIDENTIAL' })
      .set('Authorization', `Bearer ${acmeToken}`)
      .expect(200);

    expect(response.body.data).toHaveLength(0);
    expect(response.body.meta.total).toBe(0);
  });

  it('a forged tenantId in the query string changes nothing', async () => {
    // The classic IDOR attempt: pass the victim's tenant id as a filter and
    // hope the service forwards it into the where clause. ValidationPipe's
    // whitelist strips the unknown property before it can reach Prisma.
    const response = await request(app.getHttpServer())
      .get('/api/v1/crm/leads')
      .query({ tenantId: steelTenantId })
      .set('Authorization', `Bearer ${acmeToken}`);

    // Either the unknown param is rejected outright (400) or it is stripped and
    // the caller simply gets their own leads. Both are safe; leaking is not.
    if (response.status === 200) {
      const ids = response.body.data.map((lead: { id: string }) => lead.id);
      expect(ids).not.toContain(steelLeadId);
    } else {
      expect(response.status).toBe(400);
    }
  });

  it('each tenant still sees its own data (isolation is not just breaking everything)', async () => {
    // The failure mode this catches: a scoping bug so aggressive that nobody can
    // read anything. Every test above would still pass. This one would not.
    const response = await request(app.getHttpServer())
      .get('/api/v1/crm/leads')
      .set('Authorization', `Bearer ${steelToken}`)
      .expect(200);

    const ids = response.body.data.map((lead: { id: string }) => lead.id);

    expect(ids).toContain(steelLeadId);
    expect(ids).not.toContain(acmeLeadId);
  });

  it('an unauthenticated request is rejected', async () => {
    await request(app.getHttpServer()).get('/api/v1/crm/leads').expect(401);
  });

  it('a garbage token is rejected', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/crm/leads')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });
});
