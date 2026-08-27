import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';

// §1.3 — the org scope travels with the request, not as a parameter threaded through
// every service. Two contexts exist and they are deliberately different shapes:
//
//   { kind: 'org' }      a tenant user's request. Carries exactly one organizationId.
//   { kind: 'platform' } an AdminUser request (§9A.2). Carries NO organizationId, and
//                        there is no code here that can turn it into one.
//
// Anything outside a context has no scope at all — the query layer throws (§1.3).
export type TenancyContext =
  | { kind: 'org'; organizationId: string }
  | { kind: 'platform' };

const als = new AsyncLocalStorage<TenancyContext>();

export function runWithOrg<T>(organizationId: string, fn: () => T): T {
  if (!organizationId) throw new Error('tenancy: runWithOrg needs a non-empty organizationId');
  return als.run({ kind: 'org', organizationId }, fn);
}

// A PLATFORM context grants NO org access. It exists so platform-admin code runs in a
// context that is *explicitly not* a tenant one, rather than in no context at all —
// the difference between "deliberately unscoped" and "someone forgot".
export function runAsPlatformAdmin<T>(fn: () => T): T {
  return als.run({ kind: 'platform' }, fn);
}

export function getContext(): TenancyContext | undefined {
  return als.getStore();
}

// Undefined both outside any context AND inside a platform one. There is intentionally
// no getOrgId variant that a PLATFORM claim can satisfy (§9A.2, §10.8).
export function getOrgId(): string | undefined {
  const ctx = als.getStore();
  return ctx?.kind === 'org' ? ctx.organizationId : undefined;
}

// §1.3 — every query on a tenant table is scoped, and a query missing the scope FAILS.
// Not "returns nothing", not "returns everything": throws. A cross-tenant leak is a
// company-ending bug, so the default for anything unrecognised is refusal.

// Derived from the schema, not hand-maintained: a new table with organizationId is
// scoped the day it is added. A new table WITHOUT one is unclassified, and an
// unclassified model throws on every query until someone decides which list it belongs
// in. That is the "table added later without scoping" bug, caught at the first query.
// AuditEvent has an organizationId but is NOT a tenant table (§9A.3). Its column is
// nullable on purpose — a platform-wide admin action belongs to no org — and injecting
// the context org would both corrupt those rows and make the cross-org read that answers
// "which admin viewed which org's data, when" impossible. Classified separately below.
export const AUDIT_MODELS: string[] = ['AuditEvent'];

export const TENANT_MODELS: string[] = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
  .map((m) => m.name)
  .filter((name) => !AUDIT_MODELS.includes(name));

// Organization has no organizationId — it IS the org. Scoped on its own primary key so a
// tenant sees exactly its own row.
export const SELF_SCOPED_MODELS: string[] = ['Organization'];

// The one deliberate exemption (§4, §9A): platform operators, no organizationId by design.
// Explicit allowlist — never "guess from the absence of a column", because that would
// silently exempt any future table someone forgot to give an organizationId.
export const EXEMPT_MODELS: string[] = ['AdminUser'];

// Operations grouped by which arg carries the scope. Anything not listed throws.
const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);
const DATA_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const HAS_DATA = new Set(['update', 'updateMany', 'updateManyAndReturn']);

type Args = Record<string, any>;

function forceOrg(data: unknown, field: string, orgId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => ({ ...d, [field]: orgId }));
  return { ...(data as object), [field]: orgId };
}

// A caller-supplied scope key is never silently rewritten. Rewriting it would turn
// `deleteMany({ where: { organizationId: OTHER } })` into a delete of the CALLER's rows,
// and `findUnique({ where: { id: otherOrg } })` on Organization into the wrong record.
// Equal is fine (services often pass it explicitly); anything else is a bug, so it throws.
function scopeWhere(where: Args | undefined, field: string, orgId: string): Args {
  const existing = (where ?? {})[field];
  if (existing !== undefined && existing !== orgId) {
    throw new Error(
      `tenancy: where.${field} was set to something other than the context org — refusing. ` +
        `Cross-org access is not available through this client (§1.3).`,
    );
  }
  return { ...(where ?? {}), [field]: orgId };
}

// §9A.3. AuditService.record() is the only writer and it takes organizationId
// explicitly (typed `string | null`, never optional), so there is nothing here to
// inject — injecting would overwrite a deliberate `null` with the caller's org and
// destroy the platform-wide row. Reads are the other half: the audit trail exists to
// answer cross-org questions, so a PLATFORM context may read it unfiltered, while a
// tenant context must name the org it means. Nothing is guessed on its behalf.
function scopeAudit(model: string, operation: string, args: Args): Args {
  if (DATA_OPS.has(operation) || operation === 'upsert') return args;
  if (getContext()?.kind === 'platform') return args;
  if ((args.where ?? {}).organizationId === undefined) {
    throw new Error(
      `tenancy: ${model}.${operation} needs an explicit where.organizationId. ` +
        `AuditEvent is not org-injected (§9A.3) — pass the org you mean, or null for ` +
        `platform-wide events.`,
    );
  }
  return args;
}

function scope(model: string, operation: string, args: Args): Args {
  const ctx = getContext();

  if (EXEMPT_MODELS.includes(model)) return args;
  if (AUDIT_MODELS.includes(model)) return scopeAudit(model, operation, args);

  const selfScoped = SELF_SCOPED_MODELS.includes(model);
  if (!selfScoped && !TENANT_MODELS.includes(model)) {
    throw new Error(
      `tenancy: model ${model} is not classified as tenant, self-scoped or exempt. ` +
        `Add organizationId to it, or add it to an allowlist in tenancy.ts.`,
    );
  }

  // §9A.2 — the safety property is structural. There is deliberately no branch below
  // that turns a PLATFORM context into org rows: platform admins reading tenant data is
  // a separate, audited API (§9A.3), not this one. Deleting this check would not "enable"
  // that feature, it would just make platform requests unscoped — which is the leak.
  if (ctx?.kind === 'platform') {
    throw new Error(
      `tenancy: platform context has no access to tenant table ${model} (§9A.2). ` +
        `Cross-org reads go through the audited platform-admin API, not this client.`,
    );
  }

  if (ctx?.kind !== 'org') {
    throw new Error(
      `tenancy: no org context for ${model}.${operation}. ` +
        `Wrap the call in runWithOrg() (§1.3 — a query missing the scope must fail, not leak).`,
    );
  }

  const orgId = ctx.organizationId;
  const field = selfScoped ? 'id' : 'organizationId';
  const next: Args = { ...args };

  if (operation === 'upsert') {
    next.where = scopeWhere(next.where, field, orgId);
    next.create = forceOrg(next.create ?? {}, field, orgId);
    next.update = forceOrg(next.update ?? {}, field, orgId);
    return next;
  }

  if (DATA_OPS.has(operation)) {
    // Force, not default: a caller-supplied organizationId is overwritten, so a
    // request body cannot plant a row in another tenant.
    next.data = forceOrg(next.data ?? {}, field, orgId);
    return next;
  }

  if (WHERE_OPS.has(operation)) {
    // findUnique/update/delete accept extra filters here (extendedWhereUnique, GA since
    // Prisma 5), so a unique id belonging to another org simply matches nothing.
    next.where = scopeWhere(next.where, field, orgId);
    if (HAS_DATA.has(operation) && next.data) next.data = forceOrg(next.data, field, orgId);
    return next;
  }

  throw new Error(
    `tenancy: operation ${model}.${operation} is not known to the scoping layer, refusing to run it.`,
  );
}

export function withTenancy<T extends PrismaClient>(client: T) {
  return client.$extends({
    name: 'tenancy',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scope(model, operation, (args ?? {}) as Args) as typeof args);
        },
      },
    },
  });
}

export type TenantPrismaClient = ReturnType<typeof withTenancy<PrismaClient>>;

// Known gaps — this layer does NOT cover, so review any use of them by hand:
//  1. $queryRaw / $executeRaw. Prisma extensions cannot scope raw SQL, and there is no
//     way to inject a WHERE into arbitrary SQL correctly. Either add the organizationId
//     predicate by hand or turn this into Postgres RLS (§1.3 allows either).
//  2. Nested writes. `data: { phones: { create: … } }` is one operation to the extension,
//     so nested rows do not get organizationId injected — required columns make that
//     fail loudly, but a nested `connect: { id: <other org row> }` would not.
//     Pass organizationId explicitly in nested writes until RLS backs this up.
//  3. Anything holding the bare PrismaClient. Only the PRISMA provider in tenancy.module
//     hands out the scoped client; constructing `new PrismaClient()` elsewhere bypasses
//     everything here.
