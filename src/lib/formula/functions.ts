import type { FormulaResultType } from "@/lib/domain/field";
import { addToDate, dateDiff, parseDateUnit, parseStoredDate, todayIn } from "./dates";
import {
  formulaDate,
  formulaError,
  isFormulaDate,
  isFormulaError,
  isTruthy,
  toNumber,
  toText,
  type FormulaDate,
  type FormulaError,
  type FormulaValue,
} from "./values";

/** Static type of an expression. `blank` is only produced by BLANK() and IF without an else branch. */
export type ValueType = FormulaResultType | "blank";

export type EvalContext = {
  now: Date;
  /** Time zone for TODAY(). Defaults to UTC so results don't depend on the machine. */
  timeZone?: string;
};

/** Arguments are thunks so IF/AND/OR evaluate lazily: `IF({B} = 0, 0, {A} / {B})` never divides by zero. */
type Thunk = () => FormulaValue;

type FunctionDefinition = {
  minArgs: number;
  maxArgs: number;
  returns: (argTypes: ValueType[]) => ValueType;
  evaluate: (args: Thunk[], context: EvalContext) => FormulaValue;
};

type PlainValue = Exclude<FormulaValue, FormulaError>;

/** Evaluates every argument; returns the first error, so errors propagate. */
function evaluateAll(args: Thunk[]): PlainValue[] | FormulaError {
  const values: PlainValue[] = [];
  for (const arg of args) {
    const value = arg();
    if (isFormulaError(value)) return value;
    values.push(value);
  }
  return values;
}

function numberArgs(args: Thunk[]): number[] | FormulaError {
  const values = evaluateAll(args);
  if (isFormulaError(values)) return values;
  const numbers: number[] = [];
  for (const value of values) {
    const number = toNumber(value);
    if (isFormulaError(number)) return number;
    numbers.push(number);
  }
  return numbers;
}

function textArgs(args: Thunk[]): string[] | FormulaError {
  const values = evaluateAll(args);
  return isFormulaError(values) ? values : values.map(toText);
}

/** Dates may also be given as text in the storage format, e.g. DATEADD("2026-01-31", 1, "month"). */
function toDate(value: PlainValue): FormulaDate | null | FormulaError {
  if (value === null || value === "") return null;
  if (isFormulaDate(value)) return value;
  if (typeof value === "string") {
    const parsed = parseStoredDate(value);
    if (parsed) return formulaDate(parsed.ms, parsed.hasTime);
  }
  return formulaError("#VALUE!", "Expected a date");
}

function finite(value: number): number | FormulaError {
  return Number.isFinite(value) ? value : formulaError("#NUM!", "Number is out of range");
}

/** Rounds half away from zero. `toPrecision` cancels binary noise: 1.005 * 100 is 100.49999999999999. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return (Math.sign(value) * Math.round(Number((Math.abs(value) * factor).toPrecision(15)))) / factor;
}

const always =
  (type: ValueType) =>
  (): ValueType =>
    type;

/** IF's type: the branches' type if they agree, ignoring a blank branch; text otherwise. */
function unify(a: ValueType, b: ValueType): ValueType {
  if (a === b || b === "blank") return a;
  if (a === "blank") return b;
  return "text";
}

export const FUNCTIONS: Record<string, FunctionDefinition> = {
  IF: {
    minArgs: 2,
    maxArgs: 3,
    returns: ([, then, otherwise]) => unify(then, otherwise ?? "blank"),
    evaluate: ([condition, then, otherwise]) => {
      const value = condition();
      if (isFormulaError(value)) return value;
      if (isTruthy(value)) return then();
      return otherwise ? otherwise() : null;
    },
  },
  AND: {
    minArgs: 1,
    maxArgs: Infinity,
    returns: always("checkbox"),
    evaluate: (args) => {
      for (const arg of args) {
        const value = arg();
        if (isFormulaError(value)) return value;
        if (!isTruthy(value)) return false;
      }
      return true;
    },
  },
  OR: {
    minArgs: 1,
    maxArgs: Infinity,
    returns: always("checkbox"),
    evaluate: (args) => {
      for (const arg of args) {
        const value = arg();
        if (isFormulaError(value)) return value;
        if (isTruthy(value)) return true;
      }
      return false;
    },
  },
  NOT: {
    minArgs: 1,
    maxArgs: 1,
    returns: always("checkbox"),
    evaluate: ([arg]) => {
      const value = arg();
      return isFormulaError(value) ? value : !isTruthy(value);
    },
  },
  SUM: {
    minArgs: 1,
    maxArgs: Infinity,
    returns: always("number"),
    evaluate: (args) => {
      const numbers = numberArgs(args);
      return isFormulaError(numbers) ? numbers : finite(numbers.reduce((sum, n) => sum + n, 0));
    },
  },
  ROUND: {
    minArgs: 1,
    maxArgs: 2,
    returns: always("number"),
    evaluate: (args) => {
      const numbers = numberArgs(args);
      if (isFormulaError(numbers)) return numbers;
      const [value, digits = 0] = numbers;
      return finite(round(value, Math.max(-10, Math.min(10, Math.trunc(digits)))));
    },
  },
  CONCAT: {
    minArgs: 1,
    maxArgs: Infinity,
    returns: always("text"),
    evaluate: (args) => {
      const texts = textArgs(args);
      return isFormulaError(texts) ? texts : texts.join("");
    },
  },
  LEN: {
    minArgs: 1,
    maxArgs: 1,
    returns: always("number"),
    evaluate: (args) => {
      const texts = textArgs(args);
      return isFormulaError(texts) ? texts : texts[0].length;
    },
  },
  UPPER: {
    minArgs: 1,
    maxArgs: 1,
    returns: always("text"),
    evaluate: (args) => {
      const texts = textArgs(args);
      return isFormulaError(texts) ? texts : texts[0].toUpperCase();
    },
  },
  LOWER: {
    minArgs: 1,
    maxArgs: 1,
    returns: always("text"),
    evaluate: (args) => {
      const texts = textArgs(args);
      return isFormulaError(texts) ? texts : texts[0].toLowerCase();
    },
  },
  DATEADD: {
    minArgs: 3,
    maxArgs: 3,
    returns: always("date"),
    evaluate: (args) => {
      const values = evaluateAll(args);
      if (isFormulaError(values)) return values;
      const date = toDate(values[0]);
      if (date === null || isFormulaError(date)) return date;
      const amount = toNumber(values[1]);
      if (isFormulaError(amount)) return amount;
      const unit = parseDateUnit(toText(values[2]));
      if (!unit) return formulaError("#VALUE!", `Unknown date unit "${toText(values[2])}"`);
      const ms = addToDate(date.ms, Math.trunc(amount), unit);
      if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) return formulaError("#NUM!", "Date is out of range");
      const hasTime = date.hasTime || unit === "hours" || unit === "minutes" || unit === "seconds";
      return formulaDate(ms, hasTime);
    },
  },
  DATETIME_DIFF: {
    minArgs: 3,
    maxArgs: 3,
    returns: always("number"),
    evaluate: (args) => {
      const values = evaluateAll(args);
      if (isFormulaError(values)) return values;
      const from = toDate(values[0]);
      const to = toDate(values[1]);
      if (isFormulaError(from)) return from;
      if (isFormulaError(to)) return to;
      if (from === null || to === null) return null;
      const unit = parseDateUnit(toText(values[2]));
      if (!unit) return formulaError("#VALUE!", `Unknown date unit "${toText(values[2])}"`);
      return dateDiff(from.ms, to.ms, unit);
    },
  },
  TODAY: {
    minArgs: 0,
    maxArgs: 0,
    returns: always("date"),
    evaluate: (_args, context) => formulaDate(todayIn(context.now, context.timeZone), false),
  },
  BLANK: {
    minArgs: 0,
    maxArgs: 0,
    returns: always("blank"),
    evaluate: () => null,
  },
};
