/**
 * Auto-attestation: buyer agent evaluates service quality after each purchase.
 *
 * Checks what the SELLER controls:
 *   1. Did they respond at all?
 *   2. Valid format (JSON with expected fields)?
 *   3. Plausible data (values in sane ranges)?
 *   4. Fresh data (generatedAt within last 5 minutes)?
 *
 * Latency is tracked but NOT scored against the seller — network/chain delays
 * aren't their fault.
 */

export interface AttestationCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface AttestationResult {
  qualityScore: number;        // 0-100
  checks: AttestationCheck[];
  latencyMs: number;           // tracked, not scored
  task: string;
  timestamp: string;
}

// ---- Per-task validators ----

interface TaskData {
  [key: string]: any;
}

function checkResponded(body: any): AttestationCheck {
  const hasData = body && typeof body === "object" && body.data;
  return {
    id: "responded",
    label: "Seller responded",
    pass: !!hasData,
    detail: hasData ? "Received response with data payload" : "No data in response",
  };
}

function checkFormat(task: string, data: TaskData): AttestationCheck {
  const requiredFields: Record<string, string[]> = {
    "price-oracle":    ["pair", "price", "slot", "generatedAt"],
    "network-report":  ["cluster", "slot", "blockHeight", "avgTps", "generatedAt"],
    "uptime-monitor":  ["cluster", "slot", "rpcLatencyMs", "status", "generatedAt"],
    "whale-watcher":   ["cluster", "slot", "topAccounts", "generatedAt"],
    "validator-score": ["cluster", "slot", "totalValidators", "activeValidators", "generatedAt"],
  };

  const fields = requiredFields[task] ?? ["generatedAt"];
  const missing = fields.filter(f => data[f] === undefined && data[f] !== 0);

  return {
    id: "format",
    label: "Valid format",
    pass: missing.length === 0,
    detail: missing.length === 0
      ? `All ${fields.length} expected fields present`
      : `Missing fields: ${missing.join(", ")}`,
  };
}

function checkPlausible(task: string, data: TaskData): AttestationCheck {
  switch (task) {
    case "price-oracle": {
      const price = Number(data.price);
      // SOL price — should be between $1 and $10,000 (generous range)
      const ok = price > 0 && price < 10_000;
      return {
        id: "plausible",
        label: "Plausible data",
        pass: ok,
        detail: ok ? `Price $${price} within sane range` : `Price $${price} looks implausible`,
      };
    }
    case "network-report": {
      const tps = Number(data.avgTps);
      const ok = tps > 0 && tps < 200_000;
      return {
        id: "plausible",
        label: "Plausible data",
        pass: ok,
        detail: ok ? `TPS ${tps} within expected range` : `TPS ${tps} looks wrong`,
      };
    }
    case "uptime-monitor": {
      const latency = Number(data.rpcLatencyMs);
      const ok = latency > 0 && latency < 30_000;
      return {
        id: "plausible",
        label: "Plausible data",
        pass: ok,
        detail: ok ? `RPC latency ${latency}ms reasonable` : `RPC latency ${latency}ms implausible`,
      };
    }
    case "whale-watcher": {
      const accounts = data.topAccounts;
      const ok = Array.isArray(accounts) && accounts.length > 0;
      return {
        id: "plausible",
        label: "Plausible data",
        pass: ok,
        detail: ok ? `${accounts.length} whale accounts returned` : "No whale accounts in response",
      };
    }
    case "validator-score": {
      const total = Number(data.totalValidators);
      const active = Number(data.activeValidators);
      const ok = total > 0 && active > 0 && active <= total;
      return {
        id: "plausible",
        label: "Plausible data",
        pass: ok,
        detail: ok
          ? `${active}/${total} validators — makes sense`
          : `Validator counts look wrong (${active}/${total})`,
      };
    }
    default:
      return { id: "plausible", label: "Plausible data", pass: true, detail: "No task-specific validation" };
  }
}

function checkFreshness(data: TaskData): AttestationCheck {
  const gen = data.generatedAt;
  if (!gen) {
    return { id: "fresh", label: "Fresh data", pass: false, detail: "No generatedAt timestamp" };
  }
  const genTime = new Date(gen).getTime();
  const now = Date.now();
  const ageMs = now - genTime;
  const ageSec = Math.round(ageMs / 1000);
  // Allow up to 5 minutes — generous for network delays
  const ok = ageMs >= 0 && ageMs < 300_000;
  return {
    id: "fresh",
    label: "Fresh data",
    pass: ok,
    detail: ok ? `Generated ${ageSec}s ago` : `Data is ${ageSec}s old — stale`,
  };
}

// ---- Main validator ----

export function validateResponse(
  task: string,
  body: any,
  latencyMs: number,
): AttestationResult {
  const checks: AttestationCheck[] = [];

  // Check 1: did the seller respond with data?
  const respondedCheck = checkResponded(body);
  checks.push(respondedCheck);

  if (!respondedCheck.pass || !body?.data) {
    // Can't check further if there's no data
    return {
      qualityScore: 0,
      checks,
      latencyMs,
      task,
      timestamp: new Date().toISOString(),
    };
  }

  const data = body.data;

  // Check 2: valid format
  checks.push(checkFormat(task, data));

  // Check 3: plausible data
  checks.push(checkPlausible(task, data));

  // Check 4: fresh data
  checks.push(checkFreshness(data));

  // Score: each check is worth 25 points
  const passed = checks.filter(c => c.pass).length;
  const qualityScore = Math.round((passed / checks.length) * 100);

  return {
    qualityScore,
    checks,
    latencyMs,
    task,
    timestamp: new Date().toISOString(),
  };
}
