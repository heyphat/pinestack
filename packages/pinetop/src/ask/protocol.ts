/**
 * The Ask contract (§4.5).
 *
 * Decision 4.5.b — an answer and a change are separate objects. The model
 * answers in prose grounded in the loaded run; if a change is warranted it
 * comes back *additionally*, as a structured proposal that the user reviews.
 *
 * Decision 4.5.d — declining to propose is a first-class outcome. Asked "is
 * this overfit?", the correct response cites PBO and deflated Sharpe and
 * recommends a re-sweep; proposing a parameter edit on that evidence would be
 * malpractice. That is what `action` is for.
 *
 * Decision 4.5.e — `edits[].input` must be a real Pine `input()` title and `to`
 * a bare value. A proposal that fails that check is rejected here, before it can
 * reach argv.
 */

import { checkTitle } from '../flags/pine-inputs.js';
import type { AskAction, Proposal, ProposalEdit } from '../state.js';

export interface AskResponse {
  answer: string;
  proposal?: Proposal;
  action?: AskAction;
}

export interface ParseResult {
  response?: AskResponse;
  /** Why the payload was refused. Shown in the drawer, never silently dropped. */
  error?: string;
  /** Non-fatal notes — e.g. an edit dropped for an unknown input title. */
  warnings: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Parse and validate a model response.
 *
 * `titles` are the script's declared input titles; when it is empty the title
 * check degrades to "cannot verify" and `pinerun` stays the authority that
 * rejects a bad `--input`.
 */
export function parseAskResponse(raw: unknown, titles: readonly string[] = []): ParseResult {
  const warnings: string[] = [];

  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: 'ask: response was not JSON', warnings };
    }
  }
  if (value == null || typeof value !== 'object') {
    return { error: 'ask: response was not an object', warnings };
  }

  const obj = value as Record<string, unknown>;
  const answer = asString(obj['answer']);
  if (answer == null) return { error: 'ask: response had no answer', warnings };

  const response: AskResponse = { answer };

  const rawProposal = obj['proposal'];
  if (rawProposal != null && typeof rawProposal === 'object') {
    const p = rawProposal as Record<string, unknown>;
    const rawEdits = Array.isArray(p['edits']) ? p['edits'] : [];
    const edits: ProposalEdit[] = [];

    for (const entry of rawEdits) {
      if (entry == null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const input = asString(e['input']);
      const to = asString(e['to']);
      if (input == null || to == null) {
        warnings.push('dropped an edit with no input title or no value');
        continue;
      }
      // §4.5.e: `to` is a bare value. "18 h" or "1.8 ATR" would fail --input
      // validation, so it is refused here with the reason named.
      if (/\s/.test(to)) {
        warnings.push(`dropped ${input}: "${to}" is a display string, not a bare value`);
        continue;
      }
      const check = checkTitle(input, titles);
      if (!check.ok) {
        warnings.push(
          check.suggestion != null
            ? `dropped ${input}: not an input() title — did the model mean "${check.suggestion}"?`
            : `dropped ${input}: not an input() title in this script`,
        );
        continue;
      }
      edits.push({
        input,
        from: asString(e['from']) ?? '',
        to,
        display: asString(e['display']) ?? `${input} → ${to}`,
      });
    }

    if (edits.length > 0) {
      response.proposal = {
        effect: asString(p['effect']) ?? '',
        note: asString(p['note']) ?? '',
        edits,
      };
    } else if (rawEdits.length > 0) {
      warnings.push('proposal had no usable edits and was discarded');
    }
  }

  const rawAction = obj['action'];
  if (rawAction != null && typeof rawAction === 'object') {
    const a = rawAction as Record<string, unknown>;
    const label = asString(a['label']);
    const key = asString(a['key']);
    if (label != null && key != null) response.action = { label, key };
  }

  return { response, warnings };
}

/**
 * What the model is allowed to see (§9).
 *
 * Derived metrics and the flags — never OHLCV bars, never script source, never
 * credentials. The user sees exactly this payload before the first send, which
 * is the other half of the promise: the model is shown what the user is shown.
 */
export interface Grounding {
  command: string;
  /** The composed, redacted invocation. */
  invocation: string;
  /** Report fields only: metrics, per-window verdicts, exit-reason tallies. */
  report: Record<string, unknown>;
  /** Declared input titles, so a proposal can name a real one (§4.5.e). */
  inputTitles: string[];
}

/** Keys that may never be forwarded, whatever the report shape. */
const FORBIDDEN = new Set([
  'plots',
  'closes',
  'barTimes',
  'equityCurve',
  'bars',
  'source',
  'points',
  'apiKey',
  'apiSecret',
]);

/**
 * Strip a report to the fields the model may see. Series are replaced by their
 * length, so the model can say "1,284 trades" without receiving the ledger.
 */
export function groundReport(report: unknown, depth = 0): Record<string, unknown> {
  if (report == null || typeof report !== 'object' || depth > 3) return {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(report as Record<string, unknown>)) {
    if (FORBIDDEN.has(key)) {
      if (Array.isArray(value)) out[`${key}Count`] = value.length;
      continue;
    }
    if (Array.isArray(value)) {
      // Keep small object arrays (windows, sleeves, fetchErrors); summarize the
      // long numeric series that make a report heavy and say nothing extra.
      if (value.length <= 32 && value.every((v) => v != null && typeof v === 'object')) {
        out[key] = value.map((v) => groundReport(v, depth + 1));
      } else {
        out[`${key}Count`] = value.length;
      }
      continue;
    }
    if (value != null && typeof value === 'object') {
      out[key] = groundReport(value, depth + 1);
      continue;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      out[key] = value > 0 ? 'Infinity' : Number.isNaN(value) ? null : '-Infinity';
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** A provider is injected so the app never hardcodes a model call (§9 opt-in). */
export interface AskProvider {
  /** Human label shown before first use, e.g. "claude-opus-5 (remote)". */
  readonly label: string;
  /** True when the payload leaves the machine — the UI must say so (§9). */
  readonly remote: boolean;
  ask(question: string, grounding: Grounding): Promise<unknown>;
}

/** The system contract handed to a provider, so every implementation agrees. */
export const ASK_CONTRACT = `You answer questions about a completed pinerun report.

Reply with JSON only:
  {"answer": "<prose grounded in the report>",
   "proposal": {"effect": "est. …", "note": "…",
                "edits": [{"input":"<Pine input() title>","from":"…","to":"<bare value>","display":"…"}]},
   "action": {"label":"…","key":"…"}}

Rules:
- Every claim in "answer" must cite a field that is present in the report.
- "proposal" is OPTIONAL. Omit it unless a parameter change is genuinely warranted.
- When the evidence calls for more validation rather than a parameter edit
  (overfitting, too few trades, an unstable sweep surface), omit "proposal" and
  return "action" instead — e.g. {"label":"open parameter sweep","key":"s"}.
- "edits[].input" MUST be one of the declared input titles handed to you.
- "edits[].to" MUST be a bare value: 18, not "18 h"; 1.8, not "1.8 ATR".
- Estimated effects are predictions. Prefix them with "est.".`;
