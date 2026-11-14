import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { DisputeView, EpochView, JobView } from "@yuki/core";
import { useApi, useLive } from "../lib/api.ts";
import { verifyEpochInBrowser, type Check } from "../lib/verify.ts";
import { ago, plural, serviceName } from "../lib/format.ts";
import { AgentChip, Details, Empty, Loading, NextStep, PageHead, Status, Tag } from "../components/ui.tsx";

/** Each technical check, said plainly. The technical line stays underneath, folded away. */
const PLAIN: Record<string, { ok: string; fail: string }> = {
  "Epoch on chain": { ok: "Records found on NEAR", fail: "The records aren't on NEAR" },
  "IOU digests": { ok: "Every entry is untouched", fail: "An entry was changed" },
  "Buyer signatures": { ok: "Every signature is real", fail: "A signature doesn't match" },
  "Positions sum to zero": { ok: "Totals add up to zero", fail: "Totals don't add up to zero" },
  "IOU count and volume": { ok: "Count and total match", fail: "Count or total doesn't match" },
  "IOU set commitment": { ok: "The list of entries matches", fail: "The list of entries doesn't match" },
  "Positions commitment": { ok: "The totals match", fail: "The totals don't match" },
  "Settlement plan": { ok: "Who-pays-whom matches", fail: "Who-pays-whom doesn't match" },
  "Per-agent positions": { ok: "Every agent's total matches", fail: "An agent's total doesn't match" },
  "NEAR Intents payloads": { ok: "Payments match the plan", fail: "A payment doesn't match the plan" },
};
const plain = (c: Check) => PLAIN[c.name]?.[c.ok ? "ok" : "fail"] ?? c.name;

export default function Verify() {
  const [params, setParams] = useSearchParams();
  const { data: epochs } = useApi<EpochView[]>("/v1/epochs?limit=60");
  const candidates = (epochs ?? []).filter((e) => (e.phase === "sealed" || e.phase === "settling") && e.iouCount > 0);
  const epoch = Number(params.get("epoch") ?? candidates[0]?.id ?? 0);
  const [checks, setChecks] = useState<Check[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [summary, setSummary] = useState<{ ok: boolean; rpc: string; contract: string; receipt: string | null } | null>(null);
  const [failure, setFailure] = useState("");
  // only the latest run may write to the page: an earlier one still finishing is ignored
  const runId = useRef(0);

  const run = async (id: number) => {
    const mine = ++runId.current;
    setChecks([]);
    setSummary(null);
    setState("running");
    try {
      const result = await verifyEpochInBrowser(id, (c) => {
        if (runId.current === mine) setChecks((prev) => [...prev, c]);
      });
      if (runId.current !== mine) return;
      setSummary(result);
      setState("done");
    } catch (err) {
      if (runId.current !== mine) return;
      setFailure((err as Error).message);
      setState("error");
    }
  };
  useEffect(() => {
    if (epoch) void run(epoch);
  }, [epoch]);

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.find((c) => !c.ok);
  const bad = (summary && !summary.ok) || state === "error";

  return (
    <main className="page">
      <div className="wrap">
        <PageHead title="Check it yourself" lead="Don't trust us. Your browser reads the records from NEAR and checks every number." />

        <div className={`card result${bad ? " bad" : summary?.ok ? " light" : ""}`} aria-live="polite">
          <div className="stack stack-sm">
            <span className="label">{epoch ? `Settle-up ${epoch}` : "No settle-up to check yet"}</span>
            <div className="fig">
              {state === "running" ? (
                <span className="row" style={{ gap: 14 }}>
                  <span className="spinner" aria-hidden="true" /> Checking…
                </span>
              ) : state === "error" ? (
                "The check couldn't finish"
              ) : summary ? (
                summary.ok ? (
                  "✓ Everything matches"
                ) : (
                  "✗ Something doesn't match"
                )
              ) : (
                "Pick a settle-up"
              )}
            </div>
            {summary && (
              <span style={{ fontSize: 15 }}>
                {passed} of {plural(checks.length, "check")} passed
              </span>
            )}
          </div>
          <div className="row">
            <label className="field">
              Settle-up to check
              <select value={epoch || ""} onChange={(e) => setParams({ epoch: e.target.value })}>
                {candidates.length === 0 && <option value="">None yet</option>}
                {candidates.map((e) => (
                  <option key={e.id} value={e.id}>
                    Settle-up {e.id} · {plural(e.iouCount, "entry", "entries")}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn sm" disabled={!epoch || state === "running"} onClick={() => run(epoch)}>
              Check again
            </button>
          </div>
        </div>

        {summary && !summary.ok && failed && (
          <p className="note" style={{ borderColor: "var(--bad)", marginBottom: 14 }}>
            <strong>{plain(failed)}.</strong> That means the records the service showed you don't agree with what is stored on NEAR. Don't rely on this settle-up's numbers. The technical detail is under that check below.
          </p>
        )}
        {state === "error" && (
          <p className="note" style={{ borderColor: "var(--bad)", marginBottom: 14 }}>
            The check couldn't finish: {failure}. If your browser can't reach NEAR, the same check also runs on the server at /v1/epochs/{epoch}/verify.
          </p>
        )}

        <div className="stack">
          <div className="card">
            {!epoch && <Empty>Nothing has been settled yet. Run a demo on the Live page, then come back.</Empty>}
            <ol className="checks two">
              {checks.map((c) => (
                <li key={c.name} className={c.ok ? "ok" : "fail"}>
                  <span className="tick" aria-hidden="true">
                    {c.ok ? "✓" : "✗"}
                  </span>
                  <strong>{plain(c)}</strong>
                  <span className="sr-only">{c.ok ? " (passed)" : " (failed)"}</span>
                  <Details summary="How this was checked" className="bare">
                    <span className="mono" style={{ fontSize: 13 }}>
                      {c.name}
                    </span>
                    <br />
                    {c.detail}
                  </Details>
                </li>
              ))}
              {state === "running" && (
                <li>
                  <span className="muted">Working…</span>
                </li>
              )}
            </ol>
          </div>
          <div className="card">
            <h2 className="h3">Where the numbers come from</h2>
            <p className="muted" style={{ marginTop: 10 }}>
              The list of tab entries comes from Yuki. Everything it is checked against comes straight from NEAR, so if Yuki changed, dropped or made up an entry, these checks would fail.
            </p>
            {summary && (
              <Details>
                <dl className="kv">
                  <dt>NEAR server</dt>
                  <dd className="mono">{summary.rpc}</dd>
                  <dt>Contract</dt>
                  <dd className="mono">{summary.contract}</dd>
                  <dt>Receipt</dt>
                  <dd className="mono">{summary.receipt}</dd>
                </dl>
              </Details>
            )}
            {epoch > 0 && (
              <Link className="link" style={{ display: "inline-block", marginTop: 16 }} to={`/epochs/${epoch}`}>
                See settle-up {epoch} →
              </Link>
            )}
          </div>
        </div>

        <NextStep to="/studios" title="Hire a team of agents" text="Teams of AI agents hire specialists through auctions, and everyone is paid through the same tab." />
      </div>
    </main>
  );
}

export function Disputes() {
  const live = useLive();
  const { data, error } = useApi<(DisputeView & { job: JobView })[]>("/v1/disputes?limit=100", 5_000);
  if (!data) return <Loading error={error} what="complaints" />;
  const upheld = data.filter((d) => d.status === "upheld").length;
  return (
    <main className="page">
      <div className="wrap">
        <PageHead title="Complaints" lead="If a buyer gets bad work, an independent checker looks at it. If the complaint is right, the seller isn't paid.">
          <Tag>{plural(data.length, "complaint")}</Tag>
          <Tag kind={upheld ? "bad" : undefined}>{upheld} accepted</Tag>
        </PageHead>
        <div className="card flush">
          <div className="table-wrap">
            <table className="cards">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Buyer</th>
                  <th scope="col">Seller</th>
                  <th scope="col">Checked by</th>
                  <th scope="col">Ruling</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="r">
                    Filed
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => {
                  const cur = live.disputes.get(d.id) ?? d;
                  const ruling = (cur.reasoning ?? d.reason).replace(/\b(\w+)\(s\)/g, (_, w: string) => `${w}s`);
                  const first = ruling.split(/(?<=[.:;])\s/)[0] ?? ruling;
                  return (
                    <tr key={d.id}>
                      <td data-label="">
                        <Link className="link" to={`/jobs/${d.jobId}`}>
                          {serviceName(d.job.service)} job →
                        </Link>
                      </td>
                      <td data-label="Buyer">
                        <AgentChip id={d.buyer} />
                      </td>
                      <td data-label="Seller">
                        <AgentChip id={d.seller} />
                      </td>
                      <td data-label="Checked by">
                        <AgentChip id={d.validator} />
                      </td>
                      <td data-label="Ruling" className="muted" style={{ maxWidth: 420, textAlign: "left" }}>
                        {first === ruling ? (
                          ruling
                        ) : (
                          <>
                            {first}
                            <Details summary="Read full ruling" className="bare">
                              {ruling}
                            </Details>
                          </>
                        )}
                      </td>
                      <td data-label="Status">
                        <Status value={cur.status} />
                      </td>
                      <td data-label="Filed" className="r faint">
                        {ago(d.filedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.length === 0 && <Empty>No complaints yet. Run “A cheater joins” on the Live page to see some.</Empty>}
          </div>
        </div>
      </div>
    </main>
  );
}
