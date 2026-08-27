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
//
// "Not injected" is NOT "not checked". A tenant context may only name its OWN org, in
// both directions: reading another org's trail is a leak, and writing one is worse —
// AuditEvent is immutable and undeletable by trigger, so a forged DRAFT_APPROVED row
// attributed to another tenant's owner (§9, §9A.3) can never be taken back.
function requireAuditOrg(payload: unknown, orgId: string, where: string): void {
  for (const row of Array.isArray(payload) ? payload : [payload]) {
    if (!row || typeof row !== 'object') continue;
    if ((row as Args).organizationId !== orgId) {
      throw new Error(
        `tenancy: AuditEvent.${where}.organizationId must be the context org (${orgId}) — refusing. ` +
          `A tenant context cannot write a row attributed to another org, or a ` +
          `platform-wide (null) one (§9A.3).`,
      );
    }
  }
}

function scopeAudit(model: string, operation: string, args: Args): Args {
  const ctx = getContext();
  // A platform context keeps its free hand: null rows and cross-org rows, read and write.
  if (ctx?.kind === 'platform') return args;
  if (ctx?.kind !== 'org') {
    throw new Error(
      `tenancy: no context for ${model}.${operation}. The audit trail is not readable or ` +
        `writable without one — wrap the call in runWithOrg() or runAsPlatformAdmin() (§1.3).`,
    );
  }
  const orgId = ctx.organizationId;

  if (DATA_OPS.has(operation) || operation === 'upsert') {
    requireAuditOrg(args.data, orgId, 'data');
    if (operation === 'upsert') {
      requireAuditOrg(args.create, orgId, 'create');
      requireAuditOrg(args.update, orgId, 'update');
      args = { ...args, where: scopeWhere(args.where, 'organizationId', orgId) };
    }
    return args;
  }

  if ((args.where ?? {}).organizationId === undefined) {
    throw new Error(
      `tenancy: ${model}.${operation} needs an explicit where.organizationId. ` +
        `AuditEvent is not org-injected (§9A.3) — pass the org you mean, or null for ` +
        `platform-wide events.`,
    );
  }
  // Defined is not enough: it must BE the context org. scopeWhere refuses anything else,
  // including null — a tenant's own trail is the only trail it may read.
  return { ...args, where: scopeWhere(args.where, 'organizationId', orgId) };
}

// ---------------------------------------------------------------------------
// Nested args (§1.3, defence in depth behind the composite foreign keys)
//
// $allOperations only ever sees the TOP-LEVEL args. Everything under
// `data: { phones: { create: … } }` or `data: { users: { connect: { id } } }` is one
// operation to this extension, so nothing below the first level was scoped at all: a
// nested connect stole another org's row outright, a nested create planted one inside
// another org. The database now refuses both — every cross-row relation carries
// (organizationId, id) in its foreign key — and this walk refuses them one layer
// earlier, with an error that says why.
//
// The rule is the same at every depth: a nested node may only ever name THIS org.
// Relation targets (connect/connectOrCreate/set/disconnect) must name it explicitly,
// because an id on its own says nothing about which tenant owns the row.
const RELATIONS: Record<string, Record<string, string>> = Object.fromEntries(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    Object.fromEntries(m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type])),
  ]),
);

const TARGET_OPS = new Set(['connect', 'connectOrCreate', 'set', 'disconnect']);

// Which column carries the org on this model — null for models the guard does not own.
function orgFieldOf(model: string): string | null {
  if (SELF_SCOPED_MODELS.includes(model)) return 'id';
  return TENANT_MODELS.includes(model) ? 'organizationId' : null;
}

function refuseNested(path: string, model: string, found: unknown, orgId: string): never {
  throw new Error(
    `tenancy: nested ${path} on ${model} names organizationId ${JSON.stringify(found)}, ` +
      `not the context org ${orgId} — refusing. Nested writes cannot cross an org ` +
      `boundary (§1.3).`,
  );
}

function walkNested(model: string, node: unknown, orgId: string, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkNested(model, n, orgId, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object' || node instanceof Date) return;
  const obj = node as Args;

  const field = orgFieldOf(model);
  // Only a plain scalar is judged: `{ organizationId: { in: [...] } }` is a filter, not
  // a claim of ownership, and the top-level scope already bounds what it can match.
  if (field && (typeof obj[field] === 'string' || obj[field] === null) && obj[field] !== orgId) {
    refuseNested(`${path}.${field}`, model, obj[field], orgId);
  }

  for (const [key, value] of Object.entries(obj)) {
    const related = RELATIONS[model]?.[key];
    if (!related) {
      walkNested(model, value, orgId, `${path}.${key}`);
      continue;
    }
    // A relation field: its value is a map of nested operations (or a filter).
    if (!value || typeof value !== 'object') continue;
    for (const [op, payload] of Object.entries(value as Args)) {
      if (op === 'connectOrCreate') {
        for (const one of Array.isArray(payload) ? payload : [payload]) {
          requireTargetOrg(related, (one as Args)?.where, orgId, `${path}.${key}.connectOrCreate.where`);
          walkNested(related, (one as Args)?.create, orgId, `${path}.${key}.connectOrCreate.create`);
        }
      } else if (TARGET_OPS.has(op)) {
        requireTargetOrg(related, payload, orgId, `${path}.${key}.${op}`);
      } else {
        walkNested(related, payload, orgId, `${path}.${key}.${op}`);
      }
    }
  }
}

// A relation target is a row that already exists somewhere. Its id alone cannot say
// which tenant owns it, so the caller must name the org — via `organizationId`, or via
// the `organizationId_id` composite unique the schema now carries for exactly this.
function requireTargetOrg(model: string, payload: unknown, orgId: string, path: string): void {
  const field = orgFieldOf(model);
  if (field === null) return; // AdminUser and friends — nothing org-shaped to check.
  for (const one of Array.isArray(payload) ? payload : [payload]) {
    if (!one || typeof one !== 'object') continue; // `disconnect: true`
    const target = one as Args;
    const named =
      target[field] ?? (target.organizationId_id as Args | undefined)?.organizationId;
    if (named !== orgId) refuseNested(path, model, named, orgId);
  }
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

  // Everything below the top level, once the top level has been forced/checked.
  const guarded = (a: Args): Args => {
    walkNested(model, a, orgId, model);
    return a;
  };

  if (operation === 'upsert') {
    next.where = scopeWhere(next.where, field, orgId);
    next.create = forceOrg(next.create ?? {}, field, orgId);
    next.update = forceOrg(next.update ?? {}, field, orgId);
    return guarded(next);
  }

  if (DATA_OPS.has(operation)) {
    // Force, not default: a caller-supplied organizationId is overwritten, so a
    // request body cannot plant a row in another tenant.
    next.data = forceOrg(next.data ?? {}, field, orgId);
    return guarded(next);
  }

  if (WHERE_OPS.has(operation)) {
    // findUnique/update/delete accept extra filters here (extendedWhereUnique, GA since
    // Prisma 5), so a unique id belonging to another org simply matches nothing.
    next.where = scopeWhere(next.where, field, orgId);
    if (HAS_DATA.has(operation) && next.data) next.data = forceOrg(next.data, field, orgId);
    return guarded(next);
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
//  2. Nested writes are NOT injected — they are checked (walkNested) and, underneath
//     that, refused by the database: User and Dealer carry a unique (organizationId, id)
//     and every cross-row relation's foreign key includes the org. So a nested write
//     must name this org explicitly; passing nothing fails on the required column, and
//     passing another org's fails twice over. What is still NOT covered: a nested
//     `connect` on a relation the database cannot constrain — moving a row between orgs
//     by connecting it to another Organization is caught here, in the application layer
//     only, because a row's own organizationId is a legal value for any org as far as
//     Postgres is concerned. RLS (§1.3) is the thing that would close that in the
//     database too.
//  3. Anything holding the bare PrismaClient. Only the PRISMA provider in tenancy.module
//     hands out the scoped client; constructing `new PrismaClient()` elsewhere bypasses
//     everything here.
