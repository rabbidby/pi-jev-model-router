import { updateLedger } from "../../extensions/pi-jev-model-router/budget";

const [file, sessionId, countRaw] = process.argv.slice(2);
const count = Number.parseInt(countRaw ?? "", 10);
if (!file || !sessionId || !Number.isFinite(count) || count <= 0) {
  throw new Error("usage: ledger-worker <file> <session-id> <count>");
}

for (let index = 0; index < count; index += 1) {
  await updateLedger(file, {
    type: "cost",
    sessionId,
    modelKey: "test/model",
    usd: 0.1,
  });
}
