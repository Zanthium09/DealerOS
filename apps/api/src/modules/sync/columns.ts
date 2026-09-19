import type { Row } from '../contacts/parse';

// Header aliases seen in real accounting exports (Tally, Busy, Marg, hand-kept Excel).
// Matched on a squashed form, same as contacts/normalize.ts, so "Invoice No.",
// "invoice_no" and "INVOICENO" all land the same.
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export const ORDER_FIELDS = {
  orderRef: ['orderno', 'ordernumber', 'orderid', 'voucherno', 'vouchernumber', 'invoiceno', 'invoicenumber', 'invoice', 'billno', 'ref', 'reference'],
  orderDate: ['date', 'orderdate', 'invoicedate', 'voucherdate', 'billdate'],
  dealerName: ['party', 'partyname', 'dealer', 'dealername', 'customer', 'customername', 'businessname', 'ledger', 'ledgername', 'name'],
  phone: ['phone', 'mobile', 'phoneno', 'mobileno', 'contactno', 'whatsapp'],
  email: ['email', 'emailid', 'emailaddress'],
  total: ['total', 'totalvalue', 'ordervalue', 'invoiceamount', 'grandtotal', 'netamount', 'amount', 'value'],
  sku: ['sku', 'itemcode', 'productcode', 'code'],
  productName: ['product', 'productname', 'itemname', 'item', 'description', 'particulars'],
  quantity: ['qty', 'quantity', 'units'],
  unitPrice: ['rate', 'price', 'unitprice', 'unitrate', 'mrp'],
} as const;

export const PAYMENT_FIELDS = {
  invoiceRef: ['invoiceno', 'invoicenumber', 'invoice', 'billno', 'voucherno', 'ref', 'reference'],
  dealerName: ['party', 'partyname', 'dealer', 'dealername', 'customer', 'customername', 'businessname', 'ledger', 'ledgername', 'name'],
  phone: ['phone', 'mobile', 'phoneno', 'mobileno', 'contactno', 'whatsapp'],
  email: ['email', 'emailid', 'emailaddress'],
  amount: ['amount', 'invoiceamount', 'billamount', 'total', 'invoicevalue'],
  dueDate: ['duedate', 'due', 'paymentduedate'],
  paidAmount: ['paid', 'paidamount', 'received', 'amountpaid', 'receipt', 'receivedamount'],
  paidDate: ['paiddate', 'receiveddate', 'paymentdate', 'receiptdate'],
} as const;

export const PRODUCT_FIELDS = {
  sku: ['sku', 'itemcode', 'productcode', 'code'],
  name: ['name', 'product', 'productname', 'itemname', 'item', 'description'],
  category: ['category', 'group', 'itemgroup', 'productcategory'],
  unitPrice: ['price', 'unitprice', 'rate', 'mrp', 'sellingprice'],
  active: ['active', 'status'],
} as const;

export type Mapping<F extends Record<string, readonly string[]>> = Partial<Record<keyof F, string>>;

/** First unclaimed header per field; an explicit `override` always wins. */
export function detectMapping<F extends Record<string, readonly string[]>>(
  headers: string[],
  fields: F,
  override: Mapping<F> = {},
): Mapping<F> {
  const out: Mapping<F> = { ...override };
  const taken = new Set(Object.values(override) as string[]);
  for (const field of Object.keys(fields) as (keyof F)[]) {
    if (out[field]) continue;
    const hit = headers.find((h) => !taken.has(h) && fields[field].includes(squash(h)));
    if (hit) {
      out[field] = hit;
      taken.add(hit);
    }
  }
  return out;
}

export const cellOf = (row: Row, header: string | undefined): string => (header ? (row[header] ?? '').trim() : '');
