/**
 * §1.4 — numbers come from the database, never from the model.
 *
 * "Enforced structurally" means: there is no way to *express* a free-text number in
 * this API. Three locks, and all three are needed:
 *
 *   1. A template is not a string. `Template` is branded, so the only way to obtain
 *      one is `template()`, which refuses any digit outside a `{{placeholder}}`.
 *   2. A variable is not a string or a number. `DraftVariable` is a closed union with
 *      no bare-string member, so `{ amountDue: '₹5,000' }` does not typecheck. The
 *      only member that carries prose, `text()`, refuses digits at runtime — so the
 *      text slot cannot be used to smuggle one either.
 *   3. Every value is rendered here, in code, from the typed variable, AFTER the model
 *      has returned (drafting.service.ts). The model never sees a value at all — it
 *      only ever sees placeholders — so there is nothing for it to restate or round.
 *
 * Digit means every Unicode numeric category, not `[0-9]` and not `\p{Nd}` alone:
 * "५०००" and "٥٠٠٠" are numbers, and so are "Ⅻ" (Nl) and "½", "⁵⁰⁰⁰", "①" (No).
 * A dealer reads "₹¾ lakh" as an amount whatever category Unicode files it under.
 *
 * ponytail: this stops digits, not the words "five thousand". A model writing a number
 * out in words is not caught here and no cheap check catches it; the human approval
 * queue (§9) is the backstop. Upgrade path if it ever bites: a number-word denylist in
 * `assertNoDigits`.
 */

const DIGIT = /[\p{Nd}\p{Nl}\p{No}]/u;
export const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z_]*)\}\}/g;

export class DraftingError extends Error {}

/** Strips `{{placeholders}}` first — those are slots, not content. */
export function assertNoDigits(text: string, what: string): void {
  const bare = text.replace(PLACEHOLDER, '');
  if (DIGIT.test(bare)) {
    throw new DraftingError(
      `${what} contains a digit. Every number in a message comes from a typed variable, ` +
        `never from free text (§1.4).`,
    );
  }
}

export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

// --------------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------------

declare const TEMPLATE_BRAND: unique symbol;
/** A digit-free skeleton. Obtainable only from `template()` — a plain string is not
 *  assignable, which is what makes "just pass the sentence with the amount in it"
 *  a compile error rather than a code-review note. */
export type Template = string & { readonly [TEMPLATE_BRAND]: true };

export function template(text: string): Template {
  if (!text.trim()) throw new DraftingError('template is empty');
  assertNoDigits(text, 'template');
  return text as Template;
}

// --------------------------------------------------------------------------
// Variables
// --------------------------------------------------------------------------

export type DraftVariable =
  /** Money in paise — integer, never a float, never a formatted string. */
  | { kind: 'money'; amountPaise: number }
  | { kind: 'quantity'; value: number; unit: string | null }
  | { kind: 'percent'; value: number }
  | { kind: 'date'; iso: string }
  | { kind: 'text'; value: string }
  | { kind: 'name'; value: string };

export type DraftVariables = Record<string, DraftVariable>;

/** §1.4's subject matter: money owed, a discount, a scheme term, a quantity.
 *  `containsFinancialTerms` is derived from this set and nothing else — never asked
 *  of the model (§1.5). */
const FINANCIAL_KINDS = new Set<DraftVariable['kind']>(['money', 'quantity', 'percent']);

export function containsFinancialTerms(vars: DraftVariables): boolean {
  return Object.values(vars).some((v) => FINANCIAL_KINDS.has(v.kind));
}

export function money(amountPaise: number): DraftVariable {
  if (!Number.isSafeInteger(amountPaise)) {
    throw new DraftingError(
      `money() takes whole paise from the database, got ${amountPaise}. ` +
        `Rounding rupees into a message is exactly the error §1.4 forbids.`,
    );
  }
  return { kind: 'money', amountPaise };
}

export function quantity(value: number, unit: string | null = null): DraftVariable {
  if (!Number.isFinite(value)) throw new DraftingError(`quantity() got ${value}`);
  if (unit !== null) assertNoDigits(unit, 'quantity unit');
  return { kind: 'quantity', value, unit };
}

export function percent(value: number): DraftVariable {
  if (!Number.isFinite(value)) throw new DraftingError(`percent() got ${value}`);
  return { kind: 'percent', value };
}

export function date(value: Date): DraftVariable {
  if (Number.isNaN(value.getTime())) throw new DraftingError('date() got an invalid Date');
  return { kind: 'date', iso: value.toISOString() };
}

/** The only prose slot, and it refuses digits — otherwise it would be the hole every
 *  other lock here exists to close. */
export function text(value: string): DraftVariable {
  assertNoDigits(value, 'text variable');
  return { kind: 'text', value };
}

/**
 * A verbatim database string — a dealer's business name, a contact's name, the
 * org's own name. §1.4's digit ban exists to stop the *model* from writing a
 * number; a name pulled straight from a DB column was never written by the model
 * at all, so there is nothing to distrust. Real business names routinely contain
 * digits ("24x7 Traders", "S S Enterprises No.2") and `text()` rejecting those
 * crashed cold outreach for any such dealer.
 *
 * Never pass a model's own output through `name()` to dodge the digit check —
 * it exists precisely so that path stays closed. This is for columns, not
 * completions.
 */
export function name(value: string): DraftVariable {
  return { kind: 'name', value };
}

// --------------------------------------------------------------------------
// Rendering — deterministic, in code, never by the model
// --------------------------------------------------------------------------

// Hand-rolled rather than Intl: grouping and month names must not shift under an ICU
// upgrade. A rendered amount is what the dealer reads and what the test pins.
function group(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const head = intPart.slice(0, -3);
  const tail = intPart.slice(-3);
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
}

function decimal(value: number, places: number): string {
  const fixed = Math.abs(value).toFixed(places);
  const [int, frac] = fixed.split('.');
  const sign = value < 0 ? '-' : '';
  return sign + group(int) + (frac ? `.${frac}` : '');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function renderVariable(v: DraftVariable): string {
  switch (v.kind) {
    case 'money':
      return `₹${decimal(v.amountPaise / 100, 2)}`;
    case 'quantity':
      return `${decimal(v.value, Number.isInteger(v.value) ? 0 : 2)}${v.unit ? ` ${v.unit}` : ''}`;
    case 'percent':
      return `${decimal(v.value, Number.isInteger(v.value) ? 0 : 2)}%`;
    case 'date': {
      // IST — the dealers and the staff reading this are all in one timezone (§0).
      const d = new Date(new Date(v.iso).getTime() + 5.5 * 60 * 60 * 1000);
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    case 'text':
    case 'name':
      return v.value;
  }
}

/** Substitutes every `{{name}}`. Throws on an unknown name rather than leaving the
 *  raw placeholder in a message a dealer would read. */
export function render(skeleton: string, vars: DraftVariables): string {
  return skeleton.replace(PLACEHOLDER, (_match, name: string) => {
    const v = vars[name];
    if (!v) throw new DraftingError(`no variable for placeholder {{${name}}}`);
    return renderVariable(v);
  });
}
