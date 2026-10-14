import "server-only";
import type Database from "better-sqlite3";
import type { CellValue } from "@/lib/domain/cell";
import type { Field, SelectOption } from "@/lib/domain/field";
import type { User } from "@/lib/domain/user";
import type { View } from "@/lib/domain/view";
import { EMPTY_FILTER } from "@/lib/domain/filter";
import { buildDependencyGraph, topologicalOrder } from "@/lib/formula/graph";
import { computeFields, FormulaCache, type ComputedResult } from "./compute";

/**
 * Deterministic demo data: one base, three linked tables (Orders 50 000,
 * Customers 5 000, Products 500 at scale 1), 5 formulas, 2 lookups, 3 views each.
 * `scale` shrinks the row counts for tests and quick local runs.
 */

export const BASE_ID = "bas_demo";
export const TABLE_IDS = { orders: "tbl_orders", customers: "tbl_customers", products: "tbl_products" } as const;

export const SEED_USERS: User[] = [
  { id: "usr_creator", name: "Cora Creator", role: "creator" },
  { id: "usr_editor", name: "Eddie Editor", role: "editor" },
  { id: "usr_viewer", name: "Vera Viewer", role: "viewer" },
];

/** mulberry32: tiny seeded PRNG, so every run produces the same data. */
function createRandom(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (probability: number) => next() < probability,
    money: (min: number, max: number) => Math.round((min + next() * (max - min)) * 100) / 100,
  };
}

const COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];
function options(prefix: string, labels: string[]): SelectOption[] {
  return labels.map((label, i) => ({ id: `opt_${prefix}_${i}`, label, color: COLORS[i % COLORS.length] }));
}

const pad = (value: number, length: number) => String(value).padStart(length, "0");
const DAY = 86_400_000;
const toDateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const country = options("country", ["Ukraine", "Poland", "Germany", "United States", "United Kingdom", "France"]);
const category = options("category", ["Electronics", "Home", "Garden", "Toys", "Books", "Sports"]);
const status = options("status", ["New", "Processing", "Shipped", "Delivered", "Cancelled"]);
const priority = options("priority", ["Low", "Normal", "High"]);
const channel = options("channel", ["Web", "Mobile", "Phone", "Partner"]);
const warehouse = options("warehouse", ["Kyiv", "Lviv", "Warsaw", "Berlin"]);
const tags = options("tags", ["Promo", "Wholesale", "Return", "Fragile", "B2B"]);

const customerFields: Field[] = [
  { id: "fld_c_name", name: "Name", type: "text", maxLength: 200 },
  { id: "fld_c_email", name: "Email", type: "email" },
  { id: "fld_c_country", name: "Country", type: "singleSelect", options: country },
  { id: "fld_c_discount", name: "Discount %", type: "number", precision: 0, min: 0, max: 100 },
  { id: "fld_c_since", name: "Customer since", type: "date", includeTime: false },
  { id: "fld_c_vip", name: "VIP", type: "checkbox" },
  {
    id: "fld_c_label",
    name: "Label",
    type: "formula",
    expression: 'CONCAT(UPPER({fld_c_name}), " (", {fld_c_country}, ")")',
    resultType: "text",
  },
];

const productFields: Field[] = [
  { id: "fld_p_name", name: "Name", type: "text", maxLength: 200 },
  { id: "fld_p_sku", name: "SKU", type: "text" },
  { id: "fld_p_category", name: "Category", type: "singleSelect", options: category },
  { id: "fld_p_price", name: "Price", type: "currency", currency: "USD" },
  { id: "fld_p_stock", name: "In stock", type: "number", precision: 0, min: 0 },
  { id: "fld_p_url", name: "Page", type: "url" },
];

const orderFields: Field[] = [
  { id: "fld_o_number", name: "Order #", type: "text" },
  { id: "fld_o_customer", name: "Customer", type: "link", targetTableId: TABLE_IDS.customers, multiple: false },
  { id: "fld_o_product", name: "Product", type: "link", targetTableId: TABLE_IDS.products, multiple: false },
  { id: "fld_o_qty", name: "Qty", type: "number", precision: 0, min: 0 },
  { id: "fld_o_unit_price", name: "Unit price", type: "lookup", linkFieldId: "fld_o_product", targetFieldId: "fld_p_price" },
  { id: "fld_o_cust_discount", name: "Customer discount", type: "lookup", linkFieldId: "fld_o_customer", targetFieldId: "fld_c_discount" },
  { id: "fld_o_subtotal", name: "Subtotal", type: "formula", expression: "{fld_o_qty} * {fld_o_unit_price}", resultType: "number" },
  {
    id: "fld_o_discount",
    name: "Discount",
    type: "formula",
    expression: "ROUND({fld_o_subtotal} * {fld_o_cust_discount} / 100, 2)",
    resultType: "number",
  },
  { id: "fld_o_shipping", name: "Shipping", type: "currency", currency: "USD" },
  {
    id: "fld_o_total",
    name: "Total",
    type: "formula",
    expression: "{fld_o_subtotal} - {fld_o_discount} + {fld_o_shipping}",
    resultType: "number",
  },
  { id: "fld_o_status", name: "Status", type: "singleSelect", options: status },
  { id: "fld_o_ordered_at", name: "Ordered at", type: "date", includeTime: true, timeZone: "Europe/Berlin" },
  { id: "fld_o_due", name: "Due date", type: "date", includeTime: false },
  { id: "fld_o_shipped_on", name: "Shipped on", type: "date", includeTime: false },
  {
    id: "fld_o_days_to_ship",
    name: "Days to ship",
    type: "formula",
    expression: 'DATETIME_DIFF({fld_o_shipped_on}, {fld_o_ordered_at}, "days")',
    resultType: "number",
  },
  { id: "fld_o_paid", name: "Paid", type: "checkbox" },
  { id: "fld_o_gift", name: "Gift wrap", type: "checkbox" },
  { id: "fld_o_rush", name: "Rush", type: "checkbox" },
  { id: "fld_o_priority", name: "Priority", type: "singleSelect", options: priority },
  { id: "fld_o_channel", name: "Channel", type: "singleSelect", options: channel },
  { id: "fld_o_warehouse", name: "Warehouse", type: "singleSelect", options: warehouse },
  { id: "fld_o_tags", name: "Tags", type: "multiSelect", options: tags },
  { id: "fld_o_weight", name: "Weight, kg", type: "number", precision: 2, min: 0 },
  { id: "fld_o_rating", name: "Rating", type: "number", precision: 0, min: 1, max: 5 },
  { id: "fld_o_coupon", name: "Coupon", type: "text" },
  { id: "fld_o_contact", name: "Contact email", type: "email" },
  { id: "fld_o_tracking", name: "Tracking URL", type: "url" },
  { id: "fld_o_rep", name: "Sales rep", type: "text" },
  { id: "fld_o_notes", name: "Notes", type: "text" },
  { id: "fld_o_invoice", name: "Invoice #", type: "text" },
];

function gridView(id: string, name: string, fields: Field[], overrides: Partial<View> = {}): View {
  return {
    id,
    name,
    kind: "grid",
    filter: EMPTY_FILTER,
    sorts: [],
    hiddenFieldIds: [],
    fieldOrder: fields.map((field) => field.id),
    columnWidths: {},
    rowHeight: "short",
    ...overrides,
  };
}

const TABLES = [
  {
    id: TABLE_IDS.orders,
    name: "Orders",
    fields: orderFields,
    views: [
      gridView("viw_orders_all", "All orders", orderFields),
      gridView("viw_orders_unpaid", "Unpaid", orderFields, {
        filter: { conjunction: "and", conditions: [{ fieldId: "fld_o_paid", operator: "isNotChecked" }], groups: [] },
        sorts: [{ fieldId: "fld_o_ordered_at", direction: "desc" }],
      }),
      gridView("viw_orders_large", "Large orders", orderFields, {
        filter: { conjunction: "and", conditions: [{ fieldId: "fld_o_total", operator: "gt", value: 1000 }], groups: [] },
        sorts: [{ fieldId: "fld_o_total", direction: "desc" }],
        hiddenFieldIds: ["fld_o_notes", "fld_o_coupon", "fld_o_tracking"],
      }),
    ],
  },
  {
    id: TABLE_IDS.customers,
    name: "Customers",
    fields: customerFields,
    views: [
      gridView("viw_customers_all", "All customers", customerFields),
      gridView("viw_customers_vip", "VIP", customerFields, {
        filter: { conjunction: "and", conditions: [{ fieldId: "fld_c_vip", operator: "isChecked" }], groups: [] },
      }),
      gridView("viw_customers_by_country", "By country", customerFields, {
        sorts: [
          { fieldId: "fld_c_country", direction: "asc" },
          { fieldId: "fld_c_name", direction: "asc" },
        ],
      }),
    ],
  },
  {
    id: TABLE_IDS.products,
    name: "Products",
    fields: productFields,
    views: [
      gridView("viw_products_all", "All products", productFields),
      gridView("viw_products_out", "Out of stock", productFields, {
        filter: { conjunction: "and", conditions: [{ fieldId: "fld_p_stock", operator: "eq", value: 0 }], groups: [] },
      }),
      gridView("viw_products_expensive", "Most expensive", productFields, {
        sorts: [{ fieldId: "fld_p_price", direction: "desc" }],
      }),
    ],
  },
];

const FIRST_NAMES = ["Olena", "Taras", "Anna", "Piotr", "Lukas", "Emma", "John", "Sofia", "Max", "Iryna", "Oliver", "Chloé"];
const LAST_NAMES = ["Kovalenko", "Nowak", "Müller", "Smith", "Shevchenko", "Dubois", "Schmidt", "Brown", "Bondar", "Wiśniewski"];
const ADJECTIVES = ["Smart", "Classic", "Compact", "Eco", "Pro", "Mini", "Ultra", "Soft"];
const NOUNS = ["Lamp", "Kettle", "Chair", "Drone", "Puzzle", "Backpack", "Speaker", "Novel", "Racket", "Planter"];
const REPS = ["Mykola", "Agnieszka", "Jonas", "Sarah", "Dmytro"];

type SeedRow = { id: string; values: Record<string, CellValue> };

function generateRows(scale: number) {
  const random = createRandom(42);
  const count = (n: number) => Math.max(1, Math.round(n * scale));

  const products: SeedRow[] = Array.from({ length: count(500) }, (_, i) => ({
    id: `row_p_${pad(i + 1, 5)}`,
    values: {
      fld_p_name: `${random.pick(ADJECTIVES)} ${random.pick(NOUNS)} ${i + 1}`,
      fld_p_sku: `SKU-${pad(i + 1, 5)}`,
      fld_p_category: random.pick(category).id,
      fld_p_price: random.money(5, 500),
      fld_p_stock: random.chance(0.1) ? 0 : random.int(1, 200),
      fld_p_url: `https://shop.example.com/p/${i + 1}`,
    },
  }));

  const customers: SeedRow[] = Array.from({ length: count(5000) }, (_, i) => {
    const first = random.pick(FIRST_NAMES);
    const last = random.pick(LAST_NAMES);
    return {
      id: `row_c_${pad(i + 1, 5)}`,
      values: {
        fld_c_name: `${first} ${last}`,
        fld_c_email: random.chance(0.9) ? `customer${i + 1}@example.com` : null,
        fld_c_country: random.pick(country).id,
        fld_c_discount: random.pick([0, 0, 0, 5, 10, 15, 20]),
        fld_c_since: toDateOnly(Date.UTC(2018, 0, 1) + random.int(0, 3200) * DAY),
        fld_c_vip: random.chance(0.1),
      },
    };
  });

  const orders: SeedRow[] = Array.from({ length: count(50_000) }, (_, i) => {
    const orderedAt = Date.UTC(2025, 0, 1) + Math.floor(random.next() * 640 * DAY);
    const orderStatus = random.pick(status);
    const shipped = orderStatus.label === "Shipped" || orderStatus.label === "Delivered";
    return {
      id: `row_o_${pad(i + 1, 6)}`,
      values: {
        fld_o_number: `ORD-${pad(i + 1, 6)}`,
        fld_o_customer: [random.pick(customers).id],
        fld_o_product: random.chance(0.98) ? [random.pick(products).id] : null,
        fld_o_qty: random.int(1, 20),
        fld_o_shipping: random.money(0, 50),
        fld_o_status: orderStatus.id,
        fld_o_ordered_at: new Date(orderedAt).toISOString(),
        fld_o_due: toDateOnly(orderedAt + random.int(3, 30) * DAY),
        fld_o_shipped_on: shipped ? toDateOnly(orderedAt + random.int(1, 10) * DAY) : null,
        fld_o_paid: random.chance(0.7),
        fld_o_gift: random.chance(0.1),
        fld_o_rush: random.chance(0.15),
        fld_o_priority: random.pick(priority).id,
        fld_o_channel: random.pick(channel).id,
        fld_o_warehouse: random.pick(warehouse).id,
        fld_o_tags: random.chance(0.6) ? [...new Set([random.pick(tags).id, random.pick(tags).id])] : null,
        fld_o_weight: random.money(0.1, 20),
        fld_o_rating: random.chance(0.7) ? random.int(1, 5) : null,
        fld_o_coupon: random.chance(0.2) ? random.pick(["SAVE10", "WELCOME", "BLACKFRIDAY"]) : null,
        fld_o_contact: `buyer${random.int(1, 9999)}@example.com`,
        fld_o_tracking: shipped ? `https://track.example.com/${pad(i + 1, 6)}` : null,
        fld_o_rep: random.pick(REPS),
        fld_o_notes: random.chance(0.3) ? random.pick(["Call before delivery", "Leave at the door", "Fragile!", "Повторне замовлення"]) : null,
        fld_o_invoice: random.chance(0.8) ? `INV-${pad(i + 1, 6)}` : null,
      },
    };
  });

  return { products, customers, orders };
}

/** Drops null cells: an absent key means empty, which keeps 50 000 JSON rows smaller. */
export function serializeCells(values: Record<string, CellValue>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)));
}

export function seedDatabase(db: Database.Database, scale: number) {
  // IMMEDIATE takes the write lock first, so two processes starting together can't both seed.
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM bases LIMIT 1").get()) return;

    const insertUser = db.prepare("INSERT INTO users (id, name, role) VALUES (?, ?, ?)");
    for (const user of SEED_USERS) insertUser.run(user.id, user.name, user.role);

    db.prepare("INSERT INTO bases (id, name) VALUES (?, ?)").run(BASE_ID, "Demo store");
    const insertTable = db.prepare(
      "INSERT INTO tables (id, base_id, position, name, primary_field_id, fields, version) VALUES (?, ?, ?, ?, ?, ?, 1)",
    );
    const insertView = db.prepare("INSERT INTO views (id, table_id, position, config, version) VALUES (?, ?, ?, ?, 1)");
    TABLES.forEach((table, position) => {
      insertTable.run(table.id, BASE_ID, position, table.name, table.fields[0].id, JSON.stringify(table.fields));
      table.views.forEach((view, viewPosition) => insertView.run(view.id, table.id, viewPosition, JSON.stringify(view)));
    });

    const rows = generateRows(scale);
    const rowsByTable = new Map<string, Map<string, SeedRow>>([
      [TABLE_IDS.products, new Map(rows.products.map((row) => [row.id, row]))],
      [TABLE_IDS.customers, new Map(rows.customers.map((row) => [row.id, row]))],
    ]);
    const readLinked = (tableId: string, ids: string[], fieldId: string) =>
      ids.map((id) => rowsByTable.get(tableId)?.get(id)?.values[fieldId] ?? null);

    const allFields = new Map(TABLES.flatMap((table) => table.fields).map((field) => [field.id, field]));
    const graph = buildDependencyGraph(allFields.values());
    const formulas = new FormulaCache(allFields);
    const context = { now: new Date(process.env.MOCK_NOW ?? "2026-10-13T12:00:00.000Z") };

    const insertRow = db.prepare(
      "INSERT INTO rows (id, table_id, seq, rev, created_at, updated_at, cells, errors) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
    );
    // Linked tables first, so lookups in Orders read final Customers/Products values.
    const order: [string, SeedRow[]][] = [
      [TABLE_IDS.products, rows.products],
      [TABLE_IDS.customers, rows.customers],
      [TABLE_IDS.orders, rows.orders],
    ];
    for (const [tableId, tableRows] of order) {
      const table = TABLES.find((candidate) => candidate.id === tableId)!;
      const computedIds = topologicalOrder(
        graph,
        table.fields.filter((field) => field.type === "formula" || field.type === "lookup").map((field) => field.id),
      );
      tableRows.forEach((row, i) => {
        const computed: ComputedResult = computeFields(computedIds, { values: row.values, errors: {} }, allFields, formulas, readLinked, context);
        row.values = computed.values;
        const createdAt = new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
        const errors = Object.keys(computed.errors).length > 0 ? JSON.stringify(computed.errors) : null;
        insertRow.run(row.id, tableId, i + 1, createdAt, createdAt, serializeCells(row.values), errors);
      });
    }
  }).immediate();
}
