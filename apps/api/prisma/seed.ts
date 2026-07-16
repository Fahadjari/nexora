/**
 * Seeds two complete workspaces.
 *
 * Two, not one, and that is the point. A single-tenant seed makes it impossible
 * to *see* a cross-tenant leak — every row you fetch is the right one by
 * accident. With two populated companies, a broken isolation rule shows up the
 * moment you log in as Acme and find Bright Steel's leads in your list.
 *
 * Run with: npm run db:seed
 */
import { LeadSource, LeadStatus, MembershipStatus, PrismaClient, TenantPlan, TenantStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { SYSTEM_ROLES } from '../src/modules/rbac/permissions';

const prisma = new PrismaClient();

/** The password for every seeded account. Development only, obviously. */
const DEMO_PASSWORD = 'nexora-demo-2026';

interface SeedPerson {
  email: string;
  firstName: string;
  lastName: string;
  roleKey: string;
}

interface SeedCompany {
  slug: string;
  name: string;
  industry: string;
  people: SeedPerson[];
  leads: Array<{
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    companyName?: string;
    jobTitle?: string;
    status: LeadStatus;
    source: LeadSource;
    estimatedValue?: number;
  }>;
  customers: Array<{ name: string; email: string; industry: string; taxId?: string }>;
  /**
   * Deals, placed by stage *name* rather than id — the ids do not exist until
   * the pipeline is created a few lines below, and hardcoding them would couple
   * the seed to a uuid that changes on every run.
   *
   * `daysToClose` is relative on purpose: a fixed date would drift into the past
   * and quietly turn every seeded deal overdue a few months after it was written.
   * Negative values are deliberate — see the overdue deal below.
   */
  deals: Array<{
    title: string;
    value: number;
    stage: string;
    customer?: string;
    daysToClose?: number;
  }>;
}

const COMPANIES: SeedCompany[] = [
  {
    slug: 'acme-trading',
    name: 'Acme Trading',
    industry: 'Wholesale',
    people: [
      { email: 'priya@acmetrading.in', firstName: 'Priya', lastName: 'Sharma', roleKey: 'owner' },
      { email: 'arjun@acmetrading.in', firstName: 'Arjun', lastName: 'Nair', roleKey: 'sales_executive' },
      { email: 'meera@acmetrading.in', firstName: 'Meera', lastName: 'Iyer', roleKey: 'manager' },
    ],
    leads: [
      {
        firstName: 'Rahul',
        lastName: 'Mehta',
        email: 'rahul@brightsteel.in',
        phone: '+91 98765 43210',
        companyName: 'Bright Steel Traders',
        jobTitle: 'Procurement Head',
        status: LeadStatus.QUALIFIED,
        source: LeadSource.REFERRAL,
        estimatedValue: 450_000,
      },
      {
        firstName: 'Sunita',
        lastName: 'Rao',
        email: 'sunita@vertexpackaging.com',
        companyName: 'Vertex Packaging',
        jobTitle: 'Operations Director',
        status: LeadStatus.CONTACTED,
        source: LeadSource.TRADE_SHOW,
        estimatedValue: 180_000,
      },
      {
        // Deliberately sparse: no email, no phone, no company, no value.
        // This is the lead the scoring model should rate LOW — it is the
        // honesty check on the prompt. If this one scores 80, the prompt is
        // being agreeable rather than useful.
        firstName: 'Unknown',
        lastName: 'Enquiry',
        status: LeadStatus.NEW,
        source: LeadSource.WEBSITE,
      },
    ],
    customers: [
      { name: 'Kirloskar Industries', email: 'ap@kirloskar.example', industry: 'Manufacturing', taxId: '27AAPFU0939F1ZV' },
      { name: 'Sunrise Logistics', email: 'accounts@sunrise.example', industry: 'Logistics' },
    ],
    deals: [
      {
        title: 'Annual bearings contract',
        value: 1_250_000,
        stage: 'Negotiation',
        customer: 'Kirloskar Industries',
        daysToClose: 21,
      },
      {
        title: 'Fleet spare parts — Q3',
        value: 480_000,
        stage: 'Proposal',
        customer: 'Sunrise Logistics',
        daysToClose: 45,
      },
      {
        // Overdue on purpose: its close date is in the past while it sits in an
        // open stage. This is the case the board badges in red and the forecast
        // model is told to mark down — and it only tests anything if a seeded
        // deal actually exhibits it.
        title: 'Warehouse racking refit',
        value: 320_000,
        stage: 'Needs Analysis',
        customer: 'Sunrise Logistics',
        daysToClose: -12,
      },
      {
        title: 'Conveyor belt replacement',
        value: 95_000,
        stage: 'Qualification',
        daysToClose: 60,
      },
      {
        // A won deal, so the board is not all open pipeline. It must NOT appear
        // in the weighted forecast — that is the double-counting bug the
        // forecast test guards against.
        title: 'Hydraulic pumps — repeat order',
        value: 610_000,
        stage: 'Won',
        customer: 'Kirloskar Industries',
      },
    ],
  },
  {
    slug: 'bright-steel',
    name: 'Bright Steel Traders',
    industry: 'Distribution',
    people: [
      { email: 'vikram@brightsteel.in', firstName: 'Vikram', lastName: 'Desai', roleKey: 'owner' },
      { email: 'anita@brightsteel.in', firstName: 'Anita', lastName: 'Kulkarni', roleKey: 'employee' },
    ],
    leads: [
      {
        // If this ever shows up in Acme's lead list, tenant isolation is broken.
        firstName: 'CONFIDENTIAL',
        lastName: 'BrightSteelOnly',
        email: 'secret@brightsteel.in',
        companyName: 'Should Never Appear In Acme',
        status: LeadStatus.NEW,
        source: LeadSource.COLD_CALL,
        estimatedValue: 999_999,
      },
    ],
    customers: [{ name: 'Tata Steel Processing', email: 'buy@tatasteel.example', industry: 'Manufacturing' }],
    deals: [
      {
        // Bright Steel's deal. If this ever shows up on Acme's board, tenant
        // isolation is broken — same trick as the CONFIDENTIAL lead above.
        title: 'CONFIDENTIAL — BrightSteel only',
        value: 2_400_000,
        stage: 'Proposal',
        customer: 'Tata Steel Processing',
        daysToClose: 30,
      },
    ],
  },
];

/** Turns `daysToClose` into an absolute date, relative to when the seed runs. */
function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

async function main(): Promise<void> {
  console.log('Seeding Nexora…\n');

  // Idempotent: wipe first so re-running the seed does not pile up duplicates.
  // Order matters — children before parents, since some relations are Restrict.
  await prisma.auditLog.deleteMany();
  await prisma.note.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.pipelineStage.deleteMany();
  await prisma.pipeline.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.oAuthIdentity.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();

  const passwordHash = await argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  for (const company of COMPANIES) {
    const tenant = await prisma.tenant.create({
      data: {
        slug: company.slug,
        name: company.name,
        industry: company.industry,
        status: TenantStatus.ACTIVE,
        plan: TenantPlan.GROWTH,
      },
    });

    // A paying Growth subscription. The demo companies are meant to be
    // established customers, not trials — the billing guard needs a live,
    // writable subscription or every seeded login lands read-only. Ten seats,
    // comfortably above the five people seeded, so an invite demo has room.
    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        plan: TenantPlan.GROWTH,
        status: 'ACTIVE',
        seats: 10,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Each tenant gets its own copy of the system roles, so an owner can edit
    // "Manager" for their company without touching anybody else's.
    await prisma.role.createMany({
      data: SYSTEM_ROLES.map((role) => ({
        tenantId: tenant.id,
        key: role.key,
        name: role.name,
        description: role.description,
        permissions: [...role.permissions],
        isSystem: true,
      })),
    });

    const roles = await prisma.role.findMany({ where: { tenantId: tenant.id } });
    const roleByKey = new Map(roles.map((role) => [role.key, role]));

    const users = [];
    for (const person of company.people) {
      const role = roleByKey.get(person.roleKey);
      if (!role) throw new Error(`Seed error: no role "${person.roleKey}" in ${company.slug}`);

      const user = await prisma.user.create({
        data: {
          email: person.email,
          passwordHash,
          firstName: person.firstName,
          lastName: person.lastName,
          emailVerifiedAt: new Date(),
        },
      });

      await prisma.membership.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          roleId: role.id,
          status: MembershipStatus.ACTIVE,
          acceptedAt: new Date(),
        },
      });

      users.push(user);
    }

    const owner = users[0];

    const pipeline = await prisma.pipeline.create({
      data: { tenantId: tenant.id, name: 'Sales Pipeline', isDefault: true },
    });

    await prisma.pipelineStage.createMany({
      data: [
        { pipelineId: pipeline.id, name: 'Qualification', position: 1, probability: 10 },
        { pipelineId: pipeline.id, name: 'Needs Analysis', position: 2, probability: 25 },
        { pipelineId: pipeline.id, name: 'Proposal', position: 3, probability: 50 },
        { pipelineId: pipeline.id, name: 'Negotiation', position: 4, probability: 75 },
        { pipelineId: pipeline.id, name: 'Won', position: 5, probability: 100, isWon: true },
        { pipelineId: pipeline.id, name: 'Lost', position: 6, probability: 0, isLost: true },
      ],
    });

    for (const lead of company.leads) {
      await prisma.lead.create({
        data: { ...lead, tenantId: tenant.id, ownerId: owner.id },
      });
    }

    const customersByName = new Map<string, string>();

    for (const customer of company.customers) {
      const created = await prisma.customer.create({
        data: { ...customer, tenantId: tenant.id, ownerId: owner.id },
      });

      customersByName.set(created.name, created.id);
    }

    // Stages were created by name; the deals reference them the same way.
    const stages = await prisma.pipelineStage.findMany({ where: { pipelineId: pipeline.id } });
    const stageByName = new Map(stages.map((stage) => [stage.name, stage]));

    for (const deal of company.deals) {
      const stage = stageByName.get(deal.stage);
      if (!stage) throw new Error(`Seed error: no stage "${deal.stage}" in ${company.slug}`);

      await prisma.deal.create({
        data: {
          tenantId: tenant.id,
          title: deal.title,
          value: deal.value,
          pipelineId: pipeline.id,
          stageId: stage.id,
          customerId: deal.customer ? (customersByName.get(deal.customer) ?? null) : null,
          ownerId: owner.id,
          expectedCloseDate: deal.daysToClose ? daysFromNow(deal.daysToClose) : null,
          // A deal sitting in a won or lost stage must carry a closedAt, or it
          // is a closed deal that never closed — and every report that asks
          // "what did we win this quarter?" would miss it.
          closedAt: stage.isWon || stage.isLost ? new Date() : null,
        },
      });
    }

    console.log(
      `  ${company.name} (/${company.slug}) — ` +
        `${company.people.length} people, ${company.leads.length} leads, ` +
        `${company.customers.length} customers, ${company.deals.length} deals`,
    );
  }

  console.log('\nDone. Sign in with any of these:\n');
  for (const company of COMPANIES) {
    for (const person of company.people) {
      console.log(`  ${person.email.padEnd(28)} ${person.roleKey.padEnd(18)} (${company.name})`);
    }
  }
  console.log(`\n  Password for all of them: ${DEMO_PASSWORD}\n`);
  console.log('Isolation check: sign in as priya@acmetrading.in and list leads.');
  console.log('If "CONFIDENTIAL BrightSteelOnly" appears, tenant isolation is broken.\n');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
